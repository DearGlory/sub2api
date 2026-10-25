package poison

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strings"
)

// RotationLockKey serializes blacklist publication and proxy assignment.
const RotationLockKey int64 = 0x706f69736f6e

// BlockedEgress 是黑名单中的一条记录。
type BlockedEgress struct {
	OutboundIP string
	ProxyID    *int64
	AccountID  *int64
	IsDynamic  bool
	Reason     string
	HitCount   int
}

// EgressStore 负责记录与查询被投毒的出口 IP。
//
// 直接使用 database/sql，避免把本功能耦合进现有 repository 层；删除本功能时
// 只需删掉本文件与对应迁移。
type EgressStore struct {
	db *sql.DB
}

// NewEgressStore 构造黑名单存储。db 为 nil 时所有方法为安全空操作。
func NewEgressStore(db *sql.DB) *EgressStore {
	return &EgressStore{db: db}
}

// Record 记录一次命中。同一出口 IP 重复命中只累加计数，不产生新行。
//
// 命中即永久拉黑，不存在过期或自动移除；这是有意的：投毒由出口 IP 决定，
// 同一个 IP 再次被启用只会再被投毒一次。
func (s *EgressStore) Record(ctx context.Context, ip string, proxyID, accountID *int64, isDynamic bool, reason string) error {
	if s == nil || s.db == nil {
		return nil
	}
	ip = strings.TrimSpace(ip)
	if net.ParseIP(ip) == nil {
		return fmt.Errorf("invalid egress IP")
	}
	if len(reason) > 255 {
		reason = reason[:255]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", RotationLockKey); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO poison_blocked_egress (outbound_ip, proxy_id, account_id, is_dynamic, reason)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (outbound_ip) DO UPDATE SET
			hit_count   = poison_blocked_egress.hit_count + 1,
			last_hit_at = NOW(),
			is_dynamic  = poison_blocked_egress.is_dynamic OR EXCLUDED.is_dynamic
	`, ip, proxyID, accountID, isDynamic, reason)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// IsBlocked 报告该出口 IP 是否已在黑名单中。
func (s *EgressStore) IsBlocked(ctx context.Context, ip string) (bool, error) {
	if s == nil || s.db == nil {
		return false, nil
	}
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return false, nil
	}
	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM poison_blocked_egress WHERE outbound_ip = $1)`, ip).Scan(&exists)
	return exists, err
}

// BlockedProxyIDs 返回已被拉黑的代理行 ID。
//
// 动态代理的出口 IP 与 host 无关，因此只有 is_dynamic=false 的记录才代表
// 整个代理行不可再用。
func (s *EgressStore) BlockedProxyIDs(ctx context.Context) (map[int64]struct{}, error) {
	out := make(map[int64]struct{})
	if s == nil || s.db == nil {
		return out, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT proxy_id
		FROM poison_blocked_egress
		WHERE proxy_id IS NOT NULL AND is_dynamic = FALSE
	`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return out, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// List 返回黑名单明细，按最近命中时间倒序。
func (s *EgressStore) List(ctx context.Context, limit int) ([]BlockedEgress, error) {
	if s == nil || s.db == nil {
		return nil, nil
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT outbound_ip, proxy_id, account_id, is_dynamic, reason, hit_count
		FROM poison_blocked_egress
		ORDER BY last_hit_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []BlockedEgress
	for rows.Next() {
		var e BlockedEgress
		if err := rows.Scan(&e.OutboundIP, &e.ProxyID, &e.AccountID, &e.IsDynamic, &e.Reason, &e.HitCount); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
