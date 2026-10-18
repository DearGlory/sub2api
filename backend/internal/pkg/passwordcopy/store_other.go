//go:build !linux

package passwordcopy

import "context"

// Store is a disabled-compatible placeholder on platforms without the Linux
// descriptor-relative implementation.
type Store struct {
	enabled bool
	closed  bool
}

// New reports the explicit platform restriction for enabled stores. Disabled
// stores remain no-ops and do not inspect the configured path.
func New(cfg Config) (*Store, error) {
	if !cfg.Enabled {
		return &Store{}, nil
	}
	return nil, ErrRestrictedPlatform
}

func (s *Store) Save(ctx context.Context, userID int64, password string) error {
	if s == nil || !s.enabled {
		return nil
	}
	return ErrRestrictedPlatform
}

func (s *Store) Remove(ctx context.Context, userID int64) error {
	if s == nil || !s.enabled {
		return nil
	}
	return ErrRestrictedPlatform
}

func (s *Store) Close() error {
	return nil
}
