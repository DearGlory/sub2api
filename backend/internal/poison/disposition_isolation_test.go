package poison

import (
	"context"
	"testing"
)

func TestDispositionCallbackPanicDoesNotEscape(t *testing.T) {
	h := &Handler{ReportDisposition: func(Incident, Disposition) { panic("disk callback panic") }}
	defer func() {
		if value := recover(); value != nil {
			t.Fatalf("audit callback panic escaped Handle: %v", value)
		}
	}()
	h.Handle(context.Background(), Incident{AccountID: 42, RequestID: "callback-isolation"})
}
