package service

import (
	"context"
	"fmt"
)

// RefreshPoisonGuardSnapshot publishes the committed rotation immediately.
// The transaction's durable outbox remains the retry path if cache I/O fails.
func (s *AccountService) RefreshPoisonGuardSnapshot(ctx context.Context, accountID int64) error {
	if s == nil || s.accountRepo == nil {
		return fmt.Errorf("account service unavailable")
	}
	publisher, ok := s.accountRepo.(interface {
		RefreshPoisonGuardSnapshot(context.Context, int64) error
	})
	if !ok {
		return fmt.Errorf("account snapshot publisher unavailable")
	}
	return publisher.RefreshPoisonGuardSnapshot(ctx, accountID)
}
