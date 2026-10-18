//go:build unit

package repository

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func TestEpusdtPaymentBlockClaimsMigrationWorksOnSQLite(t *testing.T) {
	migration, err := os.ReadFile("../../migrations/247_epusdt_payment_block_claims.sql")
	require.NoError(t, err)

	db, err := sql.Open("sqlite", "file:epusdt_claim_migration?mode=memory&cache=shared")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	statements := make([]string, 0)
	var current strings.Builder
	for _, line := range strings.Split(string(migration), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		current.WriteString(line)
		current.WriteByte('\n')
		if strings.Contains(line, ";") {
			statements = append(statements, current.String())
			current.Reset()
		}
	}
	if strings.TrimSpace(current.String()) != "" {
		statements = append(statements, current.String())
	}
	ctx := context.Background()
	for _, statement := range statements {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		_, err = db.ExecContext(ctx, statement)
		require.NoError(t, err, statement)
	}

	var tableName string
	require.NoError(t, db.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'epusdt_payment_claims'").Scan(&tableName))
	require.Equal(t, "epusdt_payment_claims", tableName)

	var indexName string
	require.NoError(t, db.QueryRowContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_epusdt_payment_claims_order_id'").Scan(&indexName))
	require.Equal(t, "idx_epusdt_payment_claims_order_id", indexName)

	_, err = db.ExecContext(ctx, `INSERT INTO epusdt_payment_claims (block_transaction_id, order_id, trade_no, amount, actual_amount) VALUES ('0xabc', 1, 'trade-1', 10, 12.34)`)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, `INSERT INTO epusdt_payment_claims (block_transaction_id, order_id, trade_no, amount, actual_amount) VALUES ('0xabc', 2, 'trade-2', 10, 12.34)`)
	require.Error(t, err, "block transaction ID must be a database-level unique claim")
}
