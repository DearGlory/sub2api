package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func (s *SettingService) GetPoisonSharedEnabled(ctx context.Context) (bool, error) {
	values, err := s.GetRawSettings(ctx, []string{poison.SettingSharedEnabled})
	if err != nil {
		return false, fmt.Errorf("read shared proxy settings: %w", err)
	}
	value := strings.TrimSpace(values[poison.SettingSharedEnabled])
	return value == "1" || strings.EqualFold(value, "true"), nil
}
func (s *SettingService) UpdatePoisonSharedEnabled(ctx context.Context, enabled *bool) error {
	if enabled == nil {
		return nil
	}
	if err := s.settingRepo.SetMultiple(ctx, map[string]string{poison.SettingSharedEnabled: strconv.FormatBool(*enabled)}); err != nil {
		return fmt.Errorf("save shared proxy settings: %w", err)
	}
	if s.onUpdate != nil {
		s.onUpdate()
	}
	return nil
}
