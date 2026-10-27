package handler

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// Pins both production forwarding calls, which must use Attach's current context.
// Runtime transport coverage lives in repository and service evidence tests.
func TestPoisonEvidenceResponsesForwardUsesAttachedContext(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "gateway_handler_responses.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel.Name != "ForwardAsResponses" {
			return true
		}
		calls++
		if id, ok := call.Args[0].(*ast.Ident); ok && id.Name == "requestCtx" {
			t.Error("ForwardAsResponses uses stale pre-Attach requestCtx")
		}
		return true
	})
	if calls != 2 {
		t.Fatalf("forward calls=%d want 2", calls)
	}
}
