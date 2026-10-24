package handler

import (
	"context"
	"database/sql"

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
				return nil, nil
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
		Egress:  egress,
		Prober:  prober,
		Rotator: rotator,
		DisableAccount: func(ctx context.Context, accountID int64) error {
			// 状态改 disabled，与后台手动停用的语义一致；调度随即失效。
			status := service.StatusDisabled
			_, err := accountService.Update(ctx, accountID, service.UpdateAccountRequest{
				Status: &status,
			})
			return err
		},
		RebindProxy: func(ctx context.Context, accountID int64, proxyID int64) error {
			// 把账号的 proxy_id 换成另一个可用代理。
			id := proxyID
			_, err := accountService.Update(ctx, accountID, service.UpdateAccountRequest{
				ProxyID: &id,
			})
			return err
		},
	})
}

// inUseEndpoints 返回当前被活跃账号占用的代理出口集合（host:port）。
//
// 用 host:port 而不是代理行 ID：proxies 表里同一出口存在多行记录，按 ID 排除
// 会挑到同一个出口，轮换就白做了：线上 12 个 IP 各有 3 行重复。
//
// 只统计未删除、状态为 active 的账号：停用/删除账号留下的 proxy_id 不该继续
// 占着候选位置，否则可用出口会随着账号停用而永久减少。
func inUseEndpoints(ctx context.Context, db *sql.DB) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT lower(p.host) || ':' || p.port
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
