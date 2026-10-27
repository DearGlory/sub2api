//go:build unit

package handler

import (
	"encoding/json"
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
	"os"
	"path/filepath"
	"testing"
)

func TestPoisonDispositionEvidenceWiring(t *testing.T) {
	previous := poison.CurrentHandler()
	t.Cleanup(func() { poison.AttachHandler(previous) })
	db, _, err := sqlmock.New()
	require.NoError(t, err)
	defer db.Close()
	SetupPoisonGuard(db, nil, nil)
	callback := poison.CurrentHandler().ReportDisposition
	require.NotNil(t, callback, "installed handler must persist disposition next to raw evidence")
	dir := t.TempDir()
	inc := poison.Incident{AccountID: 42, EvidenceID: "test-evidence", EvidencePath: dir, RequestID: "request-42"}
	expected := poison.Disposition{AccountID: 42, EvidenceID: inc.EvidenceID, RequestID: inc.RequestID, Outcome: "deferred", Reason: "deferred_active_query"}
	callback(inc, expected)
	body, err := os.ReadFile(filepath.Join(dir, "disposition.json"))
	require.NoError(t, err)
	var actual poison.Disposition
	require.NoError(t, json.Unmarshal(body, &actual))
	require.Equal(t, expected, actual)
	info, err := os.Stat(filepath.Join(dir, "disposition.json"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0600), info.Mode().Perm())
	callback(poison.Incident{EvidencePath: filepath.Join(dir, "missing")}, expected)
}
