//go:build unit

package poison

import (
	"context"
	"errors"
	"testing"
)

func parentCurrentIncident(f *sharedSwitchFixture) Incident {
	id := f.eligible[0]
	proxy := f.h.accountProxy(id)
	return Incident{AccountID: id, ProxyID: proxy, SharedGeneration: f.h.accountGeneration(id), Reason: "threshold:3/3", RestoreEpoch: 0, RequestID: "parent-regression"}
}
func TestSharedParentStaleSameProxyGeneration(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	inc.SharedGeneration--
	before, _ := f.co.State(context.Background())
	d, err := f.co.Handle(context.Background(), inc)
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome != "stale" {
		t.Fatalf("outcome=%s want=stale before blacklist", d.Outcome)
	}
	after, _ := f.co.State(context.Background())
	if after.Generation != before.Generation || len(after.Runs) != len(before.Runs) {
		t.Fatal("stale mutated state")
	}
	if f.h.count("SELECT count(*) FROM poison_blocked_egress WHERE outbound_ip='10.0.0.1'") != 0 {
		t.Fatal("stale wrote blacklist")
	}
}
func TestSharedParentAdminRestoreBeforeHit(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	f.h.exec(`UPDATE accounts SET extra=jsonb_set(extra,'{poison_guard_restore_epoch}','1') WHERE id=$1`, inc.AccountID)
	d, err := f.co.Handle(context.Background(), inc)
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome != "stale" {
		t.Fatalf("restored account overwritten: %s", d.Outcome)
	}
	if f.h.count("SELECT count(*) FROM poison_blocked_egress WHERE outbound_ip='10.0.0.1'") != 0 {
		t.Fatal("restored incident wrote blacklist")
	}
}
func TestSharedParentExistingBlacklistCanClearOwnNewHit(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	f.h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.1',1,'older hit')`)
	_, err := f.co.Handle(context.Background(), inc)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < len(f.eligible); i++ {
		if err = f.co.Tick(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if n := f.h.count("SELECT count(*) FROM poison_blocked_egress WHERE outbound_ip='10.0.0.1'"); n != 0 {
		t.Fatalf("own hit prevented all-clean release: rows=%d", n)
	}
}
func TestSharedParentTargetBlacklistedAfterValidation(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	f.co.opts.ValidateProxy = func(_ context.Context, c RotationCandidate) error {
		f.h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES($1,$2,'concurrent hit') ON CONFLICT(outbound_ip) DO NOTHING`, c.Host, c.ID)
		return nil
	}
	d, err := f.co.Handle(context.Background(), inc)
	if err != nil {
		t.Fatal(err)
	}
	if d.Outcome == "shared_switched" {
		t.Fatal("bound concurrently blacklisted target")
	}
	if *f.h.accountProxy(inc.AccountID) != 1 {
		t.Fatal("bad binding committed")
	}
}
func TestSharedParentInitialGenerationRejectsPreEnableRequest(t *testing.T) {
	f := newSharedSwitchFixture(t)
	if gen := f.h.accountGeneration(f.eligible[0]); gen < 1 {
		t.Fatalf("initial generation=%d leaves pre-enable requests current", gen)
	}
}
func TestSharedParentReconcileHonorsValidation(t *testing.T) {
	h := newSharedTestDB(t)
	a, b := h.addProxy("10.0.0.1", 8080, "active", false), h.addProxy("10.0.0.2", 8080, "active", false)
	id := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &a})
	calls := 0
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot, ValidateProxy: func(_ context.Context, p RotationCandidate) error {
		calls++
		if p.ID == a {
			return errors.New("offline")
		}
		return nil
	}})
	if err := co.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := h.accountProxy(id); got == nil || *got != b || calls < 2 {
		t.Fatalf("initial binding skipped validation: proxy=%v calls=%d", got, calls)
	}
}
func TestSharedParentPersistedOffPreventsHit(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	f.h.exec(`INSERT INTO settings(key,value) VALUES('poison_guard_shared_enabled','false') ON CONFLICT(key) DO UPDATE SET value='false'`)
	d, err := f.co.Handle(context.Background(), inc)
	if err != nil && !errors.Is(err, ErrSharedDisabled) {
		t.Fatal(err)
	}
	if d.Outcome == "shared_switched" {
		t.Fatal("stale local snapshot allowed switch after global disable")
	}
	if f.h.count("SELECT count(*) FROM poison_blocked_egress WHERE outbound_ip='10.0.0.1'") != 0 {
		t.Fatal("off wrote blacklist")
	}
}
