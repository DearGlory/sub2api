//go:build unit

package poison

import (
	"context"
	"testing"
)

// New admissions participate in fleet convergence. Their business state and
// restore epoch are retained even though the already-frozen probe round only
// contains accounts that existed at its creation.
func TestSharedNewAdmissionJoinsCleanCutbackPreservesRestore(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	three := int64(3)
	fresh := f.h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &three, Status: "inactive", Unschedule: true})
	f.h.setRestoreEpoch(fresh, 7)
	done := f.drainTicks(t, 60)
	if done == nil || done.State != SharedRunReleased {
		t.Fatalf("expected all-clean fleet cutback, got %+v", done)
	}
	if got := f.h.accountProxy(fresh); got == nil || *got != 1 {
		t.Fatalf("new admitted account not on shared proxy: %v", got)
	}
	if f.h.count(`SELECT count(*) FROM accounts WHERE id=$1 AND status='inactive' AND schedulable=false AND (extra->>'poison_guard_restore_epoch')::bigint=7`, fresh) != 1 {
		t.Fatal("new admission status or restore epoch changed")
	}
	if len(done.Cells) != len(run.Cells) {
		t.Fatal("frozen probe matrix changed")
	}
	for _, call := range f.probe.snapshot() {
		if call.AccountID == fresh {
			t.Fatal("new admission inserted into frozen probe matrix")
		}
	}
	state := f.state(t)
	if got := f.h.accountGeneration(fresh); got != state.Generation {
		t.Fatalf("new account generation=%d, shared=%d", got, state.Generation)
	}
	if err := f.co.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := f.h.accountProxy(fresh); got == nil || *got != *state.SharedProxyID {
		t.Fatal("new admission split from fleet after reconcile")
	}
}
