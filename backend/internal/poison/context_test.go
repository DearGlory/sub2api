package poison

import (
	"context"
	"testing"
	"time"
)

func TestCompletedContextPreservesValuesAndParentCancellation(t *testing.T) {
	type valueKey struct{}
	parent, cancelParent := context.WithDeadline(context.Background(), time.Now().Add(time.Minute))
	defer cancelParent()
	child, cancelChild := context.WithCancel(parent)
	latest := context.WithValue(child, valueKey{}, "selected-account")
	cancelChild()
	writer := &GuardWriter{parentContext: parent}
	restored := writer.restoreContext(latest)
	if restored.Err() != nil || restored.Value(valueKey{}) != "selected-account" {
		t.Fatal("restoration lost values or retained guard cancellation")
	}
	wantDeadline, _ := parent.Deadline()
	if deadline, ok := restored.Deadline(); !ok || deadline != wantDeadline {
		t.Fatal("original deadline was not preserved")
	}
	derived, cancelDerived := context.WithCancel(restored)
	defer cancelDerived()
	if derived.Err() != nil {
		t.Fatal("new child inherited canceled guard")
	}
	cancelParent()
	select {
	case <-derived.Done():
	case <-time.After(time.Second):
		t.Fatal("new child lost parent cancellation")
	}
	if restored.Err() != context.Canceled {
		t.Fatal("restored context lost parent error")
	}
}
