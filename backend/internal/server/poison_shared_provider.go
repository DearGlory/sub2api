package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

func ProvidePoisonSharedRuntime(db *sql.DB, tests *service.AccountTestService, accounts *service.AccountService) *PoisonSharedRuntime {
	plan := service.NewPoisonProbePlanService(db)
	egress := poison.NewEgressStore(db)
	validator := &poison.Rotator{Prober: poison.DefaultEgressProber(), IsEgressBlocked: egress.IsBlocked}
	coordinator := poison.NewSharedCoordinator(db, poison.SharedOptions{
		Plan:     plan.Plan,
		Probe:    tests.ProbePoisonProxy,
		Snapshot: poison.CurrentSnapshot,
		RefreshAccounts: func(ctx context.Context, ids []int64) error {
			var errs []error
			for _, id := range ids {
				if err := accounts.RefreshPoisonGuardSnapshot(ctx, id); err != nil {
					errs = append(errs, err)
				}
			}
			return errors.Join(errs...)
		},
		ValidateProxy: func(ctx context.Context, candidate poison.RotationCandidate) error {
			return validator.ValidateEgress(ctx, &candidate)
		},
	})
	return NewPoisonSharedRuntime(coordinator)
}
