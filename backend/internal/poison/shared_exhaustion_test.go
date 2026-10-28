//go:build unit

package poison

import (
	"context"
	"errors"
	"testing"
)

func TestSharedExhaustionStopsFleet(t *testing.T) {
	h := newSharedTestDB(t)
	p := h.addProxy("10.0.0.1", 8080, "active", false)
	a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	b := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	manual := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p, Unschedule: true})
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(context.Context, RotationCandidate) error { return nil }})
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	d, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome != "shared_disabled" {
		t.Fatalf("outcome=%s want shared_disabled", d.Outcome)
	}
	for _, id := range []int64{a, b} {
		if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, id); got != "inactive:false" {
			t.Fatalf("account %d state=%s", id, got)
		}
	}
	if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, manual); got != "active:false" {
		t.Fatalf("manual state overwritten: %s", got)
	}
	h.addProxy("10.0.0.2", 8080, "active", false)
	if err := co.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, a); got != "inactive:false" {
		t.Fatalf("auto restored: %s", got)
	}
}

func TestSharedExhaustionRollbackAndScope(t *testing.T) {
	h := newSharedTestDB(t)
	p := h.addProxy("10.0.0.1", 8080, "active", false)
	a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	outside := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	h.exec(`UPDATE accounts SET name='普通账号' WHERE id=$1`, outside)
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(context.Context, RotationCandidate) error { return nil }})
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	h.exec(`CREATE FUNCTION fail_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER fail_write BEFORE INSERT ON scheduler_outbox FOR EACH ROW EXECUTE FUNCTION fail_outbox()`)
	if _, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"}); err == nil {
		t.Fatal("expected injected failure")
	}
	if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, a); got != "active:true" {
		t.Fatal(got)
	}
	if n := h.count(`SELECT count(*) FROM poison_blocked_egress`); n != 0 {
		t.Fatalf("blacklist did not roll back: %d", n)
	}
	h.exec(`DROP TRIGGER fail_write ON scheduler_outbox`)
	if _, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"}); err != nil {
		t.Fatal(err)
	}
	if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, outside); got != "active:true" {
		t.Fatalf("outside modified %s", got)
	}
	if n := h.count(`SELECT count(*) FROM accounts WHERE id=$1 AND extra ? 'poison_guard_shared_generation'`, outside); n != 0 {
		t.Fatal("outside generation was written")
	}
}

func TestSharedWaitingExhaustionRespectsRestore(t *testing.T) {
	for _, restore := range []bool{false, true} {
		h := newSharedTestDB(t)
		p := h.addProxy("10.0.0.1", 8080, "active", false)
		a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
		co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(context.Context, RotationCandidate) error { return nil }})
		ctx := context.Background()
		if err := co.Reconcile(ctx); err != nil {
			t.Fatal(err)
		}
		other := h.addProxy("10.0.0.2", 8080, "active", false)
		co.opts.ValidateProxy = func(context.Context, RotationCandidate) error { return errors.New("temporary") }
		if _, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"}); err != nil {
			t.Fatal(err)
		}
		h.exec(`UPDATE proxies SET status='inactive' WHERE id=$1`, other)
		if restore {
			h.setRestoreEpoch(a, 1)
		}
		if err := co.Reconcile(ctx); err != nil {
			t.Fatal(err)
		}
		want := "inactive:false"
		if restore {
			want = "active:true"
		}
		if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, a); got != want {
			t.Fatalf("restore=%v state=%s want=%s", restore, got, want)
		}
	}
}
func TestSharedRejectedEgressStopsFleet(t *testing.T) {
	h := newSharedTestDB(t)
	p := h.addProxy("10.0.0.1", 8080, "active", false)
	a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(context.Context, RotationCandidate) error { return nil }})
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	h.addProxy("dynamic.example", 8080, "active", false)
	co.opts.ValidateProxy = func(context.Context, RotationCandidate) error { return ErrEgressBlocked }
	d, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome != "shared_disabled" {
		t.Fatalf("outcome=%s", d.Outcome)
	}
}

func TestSharedUnknownCandidateDoesNotDisable(t *testing.T) {
	h := newSharedTestDB(t)
	p := h.addProxy("10.0.0.1", 8080, "active", false)
	a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(context.Context, RotationCandidate) error { return nil }})
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	h.addProxy("10.0.0.2", 8080, "active", false)
	co.opts.ValidateProxy = func(context.Context, RotationCandidate) error { return errors.New("temporary network failure") }
	d, err := co.Handle(ctx, Incident{AccountID: a, ProxyID: &p, SharedGeneration: 1, Reason: "veto"})
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome != "shared_waiting" {
		t.Fatalf("unknown candidate outcome=%s", d.Outcome)
	}
	if got := h.one(`SELECT status||':'||schedulable::text FROM accounts WHERE id=$1`, a); got != "active:true" {
		t.Fatalf("unknown disabled: %s", got)
	}
}
