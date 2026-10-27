package repository

import (
	"context"
	"errors"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

func (r *accountRepository) clearErrorWithRestoreEpoch(ctx context.Context, id int64) error {
	baseCtx := ctx
	contextTx := dbent.TxFromContext(ctx)
	client := clientFromContext(ctx, r.client)
	var tx *dbent.Tx
	if contextTx == nil {
		var err error
		tx, err = r.client.Tx(ctx)
		if err != nil && !errors.Is(err, dbent.ErrTxStarted) {
			return err
		}
		if tx != nil {
			defer tx.Rollback()
			ctx = dbent.NewTxContext(ctx, tx)
			client = tx.Client()
		}
	}
	result, err := client.ExecContext(ctx, "UPDATE accounts SET status='active', error_message='', extra="+incrementPoisonRestoreEpochSQL("COALESCE(extra, '{}'::jsonb)")+", updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL", id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return service.ErrAccountNotFound
	}
	if err = enqueueSchedulerOutbox(ctx, client, service.SchedulerOutboxEventAccountChanged, &id, nil, nil); err != nil {
		return err
	}
	if tx != nil {
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	if contextTx == nil {
		r.syncSchedulerAccountSnapshot(baseCtx, id)
	}
	return nil
}

// Uses the pre-update row, even when the same statement replaces other extra keys.
// The account row lock taken by UPDATE serializes concurrent restores.
func incrementPoisonRestoreEpochSQL(extraExpression string) string {
	key := poison.RestoreEpochKey
	current := "(extra ->> '" + key + "')"
	invalid := "('invalid restore epoch: ' || COALESCE(" + current + ", 'null'))::bigint"
	next := "CASE WHEN NOT (COALESCE(extra, '{}'::jsonb) ? '" + key + "') THEN 1 " +
		"WHEN jsonb_typeof(extra -> '" + key + "') = 'number' AND " + current + " ~ '^(0|[1-9][0-9]{0,15})$' THEN " +
		"CASE WHEN " + current + "::bigint < 9007199254740991 THEN " + current + "::bigint + 1 ELSE " + invalid + " END ELSE " + invalid + " END"
	return "jsonb_set((" + extraExpression + "), '{" + key + "}', to_jsonb((" + next + ")::bigint), true)"
}
