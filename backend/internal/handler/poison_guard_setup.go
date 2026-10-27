package handler

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"strings"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// SetupPoisonGuard 在服务启动时装配命中后的处置逻辑。
//
// 该函数的全部作用就是给 poison 包注入回调；未调用时检测仍能拦截客户侧内容，
// 只是不会拉黑出口 IP、不会轮换代理、不会停用账号。删除本功能时一并删除本文件。
//
// 传入参数刻意保持在最小集合（db + 两个 service），避免改动 SetupRouter 的
// 既有参数列表。
func SetupPoisonGuard(db *sql.DB, proxyService *service.ProxyService, accountService *service.AccountService) {
	if db == nil {
		return
	}

	egress := poison.NewEgressStore(db)
	prober := poison.DefaultEgressProber()

	rotator := &poison.Rotator{
		ActiveProxies: func(ctx context.Context) ([]poison.RotationCandidate, error) {
			if proxyService == nil {
				return nil, poison.ErrRotationUnavailable
			}
			proxies, err := proxyService.ListActive(ctx)
			if err != nil {
				return nil, err
			}
			out := make([]poison.RotationCandidate, 0, len(proxies))
			for i := range proxies {
				p := &proxies[i]
				out = append(out, poison.RotationCandidate{
					ID:       p.ID,
					Name:     p.Name,
					Host:     p.Host,
					Port:     p.Port,
					Protocol: p.Protocol,
					Username: p.Username, Password: p.Password,
				})
			}
			return out, nil
		},
		Blocked: func(ctx context.Context) (map[int64]struct{}, error) {
			return egress.BlockedProxyIDs(ctx)
		},
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			return egress.IsBlocked(ctx, ip)
		},
		InUse: func(ctx context.Context) (map[string]struct{}, error) {
			return inUseEndpoints(ctx, db)
		},
		Prober: prober,
	}

	poison.AttachHandler(&poison.Handler{
		ReportDisposition: func(inc poison.Incident, disposition poison.Disposition) {
			if err := poison.WriteEvidenceDisposition(inc.EvidencePath, disposition); err != nil {
				log.Printf("[poison-evidence] id=%s error=disposition_write", inc.EvidenceID)
			}
		},
		Egress:  egress,
		Prober:  prober,
		Rotator: rotator,
		LookupProxy: func(ctx context.Context, id int64) (*poison.RotationCandidate, error) {
			if proxyService == nil {
				return nil, fmt.Errorf("proxy service unavailable")
			}
			p, err := proxyService.GetByID(ctx, id)
			if err != nil {
				return nil, err
			}
			return &poison.RotationCandidate{ID: p.ID, Host: p.Host, Port: p.Port, Protocol: p.Protocol, Username: p.Username, Password: p.Password}, nil
		},
		DisableIncident: func(ctx context.Context, inc poison.Incident) error {
			err := disablePoisonIncident(ctx, db, inc, func(txCtx context.Context) error {
				if accountService == nil {
					return fmt.Errorf("account service unavailable")
				}
				status := "inactive"
				_, err := accountService.Update(txCtx, inc.AccountID, service.UpdateAccountRequest{Status: &status})
				return err
			})
			if err != nil {
				return err
			}
			if err := accountService.RefreshPoisonGuardSnapshot(ctx, inc.AccountID); err != nil {
				log.Printf("[poison] account %d snapshot refresh pending: %v", inc.AccountID, err)
			}
			return nil
		},
		IncidentCurrent: func(ctx context.Context, inc poison.Incident) (bool, error) {
			return poisonIncidentCurrent(ctx, db, inc, false)
		},
		RebindIncident: func(ctx context.Context, inc poison.Incident, proxyID int64) error {
			accountID := inc.AccountID
			err := rebindPoisonProxy(ctx, db, accountID, proxyID, func(txCtx context.Context) error {
				current, err := poisonIncidentCurrent(txCtx, dbent.TxFromContext(txCtx).Client(), inc, true)
				if err != nil {
					return err
				}
				if !current {
					return poison.ErrStaleIncident
				}
				if accountService == nil {
					return fmt.Errorf("account service unavailable")
				}
				_, err = accountService.Update(txCtx, accountID, service.UpdateAccountRequest{ProxyID: &proxyID})
				return err
			})
			if err != nil {
				return err
			}
			if err := accountService.RefreshPoisonGuardSnapshot(ctx, accountID); err != nil {
				// The DB assignment is already committed. Do not rotate again only
				// because Redis is unavailable; the transactional outbox will retry.
				log.Printf("[poison] account %d snapshot refresh pending: %v", accountID, err)
			}
			return nil
		},
	})
}

// poisonIncidentCurrent prevents a late stream from rewriting a newer binding.
func poisonIncidentCurrent(ctx context.Context, db poisonQueryer, inc poison.Incident, lock bool) (bool, error) {
	query := "SELECT proxy_id, status, schedulable FROM accounts WHERE id=$1 AND deleted_at IS NULL"
	if lock {
		query += " FOR UPDATE"
	}
	rows, err := db.QueryContext(ctx, query, inc.AccountID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return false, rows.Err()
	}
	var proxy sql.NullInt64
	var status string
	var schedulable bool
	if err := rows.Scan(&proxy, &status, &schedulable); err != nil {
		return false, err
	}
	matches := !proxy.Valid && inc.ProxyID == nil
	if inc.ProxyID != nil {
		matches = proxy.Valid && proxy.Int64 == *inc.ProxyID
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	// Close before another query: transaction clients share one connection.
	if err := rows.Close(); err != nil {
		return false, err
	}
	if !matches || status != service.StatusActive || !schedulable {
		return false, nil
	}
	if inc.RequestStartedAt.IsZero() {
		return true, nil
	} // Legacy internal callers only.
	// Audit is persisted asynchronously. This protects already-visible restores;
	// it cannot serialize an admin write whose audit has not been flushed yet.
	audit, err := db.QueryContext(ctx, `SELECT action, request_body FROM audit_logs
 WHERE extra->'params'->>'id' = $1 AND created_at > $2
 AND status_code >= 200 AND status_code < 300
 AND action IN ('admin.accounts.update', 'admin.accounts.schedulable.create')`, strconv.FormatInt(inc.AccountID, 10), inc.RequestStartedAt)
	if err != nil {
		return false, err
	}
	defer audit.Close()
	for audit.Next() {
		var action, body string
		if err := audit.Scan(&action, &body); err != nil {
			return false, err
		}
		var state struct {
			Status      string `json:"status"`
			Schedulable *bool  `json:"schedulable"`
		}
		if err := json.Unmarshal([]byte(body), &state); err != nil {
			// Truncated/omitted audit bodies cannot prove the absence of a restore.
			return false, fmt.Errorf("poison restoration audit unreadable")
		}
		if action == "admin.accounts.update" && state.Status == service.StatusActive ||
			action == "admin.accounts.schedulable.create" && state.Schedulable != nil && *state.Schedulable {
			return false, nil
		}
	}
	return true, audit.Err()
}

func disablePoisonIncident(ctx context.Context, db *sql.DB, inc poison.Incident, update func(context.Context) error) error {
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	tx, err := client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	txCtx := dbent.NewTxContext(ctx, tx)
	if _, err := tx.Client().ExecContext(txCtx, "SELECT pg_advisory_xact_lock($1)", poison.RotationLockKey); err != nil {
		return err
	}
	current, err := poisonIncidentCurrent(txCtx, tx.Client(), inc, true)
	if err != nil {
		return err
	}
	if !current {
		return poison.ErrStaleIncident
	}
	if err := update(txCtx); err != nil {
		return err
	}
	return tx.Commit()
}

// rebindPoisonProxy rechecks endpoint occupancy under a cross-instance lock.
// The account service joins this transaction, preserving its outbox writes.
func rebindPoisonProxy(ctx context.Context, db *sql.DB, accountID, proxyID int64, update func(context.Context) error) error {
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	tx, err := client.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	txCtx := dbent.NewTxContext(ctx, tx)
	if _, err = tx.Client().ExecContext(txCtx, "SELECT pg_advisory_xact_lock($1)", poison.RotationLockKey); err != nil {
		return err
	}
	// Reload the target after acquiring the lock: different rows can share an endpoint.
	rows, err := tx.Client().QueryContext(txCtx, `SELECT host, port FROM proxies WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`, proxyID)
	if err != nil {
		return err
	}
	var host string
	var port int
	if !rows.Next() {
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		return fmt.Errorf("rotation proxy unavailable")
	}
	err = rows.Scan(&host, &port)
	rows.Close()
	if err != nil {
		return err
	}
	occupied, err := inUseEndpoints(txCtx, tx.Client())
	if err != nil {
		return err
	}
	if _, ok := occupied[poison.Endpoint(host, port)]; ok {
		return fmt.Errorf("rotation endpoint occupied")
	}
	blacklistRows, err := tx.Client().QueryContext(txCtx,
		`SELECT EXISTS (SELECT 1 FROM poison_blocked_egress WHERE outbound_ip=$1 OR (proxy_id=$2 AND is_dynamic=false))`, strings.TrimSpace(host), proxyID)
	if err != nil {
		return err
	}
	var blocked bool
	if !blacklistRows.Next() {
		blacklistRows.Close()
		return fmt.Errorf("missing blacklist result")
	}
	err = blacklistRows.Scan(&blocked)
	blacklistRows.Close()
	if err != nil {
		return err
	}
	if blocked {
		return fmt.Errorf("rotation endpoint blacklisted")
	}
	if err = update(txCtx); err != nil {
		return err
	}
	return tx.Commit()
}

// inUseEndpoints 返回当前被活跃账号占用的代理出口集合（host:port）。
//
// 用 host:port 而不是代理行 ID：proxies 表里同一出口存在多行记录，按 ID 排除
// 会挑到同一个出口，轮换就白做了：线上 12 个 IP 各有 3 行重复。
//
// 只统计未删除、状态为 active 的账号：停用/删除账号留下的 proxy_id 不该继续
// 占着候选位置，否则可用出口会随着账号停用而永久减少。
type poisonQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func inUseEndpoints(ctx context.Context, db poisonQueryer) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT lower(btrim(p.host)) || ':' || p.port
		FROM accounts a
		JOIN proxies p ON p.id = a.proxy_id
		WHERE a.proxy_id IS NOT NULL
		  AND a.deleted_at IS NULL
		  AND a.status = 'active'`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var ep string
		if err := rows.Scan(&ep); err != nil {
			return out, err
		}
		out[ep] = struct{}{}
	}
	return out, rows.Err()
}
