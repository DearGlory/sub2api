package poison

import "context"

// completedRequestContext retains values added by handlers while restoring the
// original request's lifetime. WithoutCancel hides the canceled child context's
// internal cancellation key as well as its Done/Err state.
type completedRequestContext struct {
	context.Context
	values context.Context
}

func (c completedRequestContext) Value(key any) any {
	return c.values.Value(key)
}

func (w *GuardWriter) restoreContext(current context.Context) context.Context {
	if w.parentContext == nil || current == nil {
		return current
	}
	return completedRequestContext{Context: w.parentContext, values: context.WithoutCancel(current)}
}
