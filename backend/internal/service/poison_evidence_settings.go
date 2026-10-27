package service

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

const (
	poisonEvidenceEnabledKey = "poison_guard_evidence_enabled"
	poisonEvidenceDirKey     = "poison_guard_evidence_dir"
	poisonEvidenceDefaultDir = "./data/poison-evidence"
)

// PoisonEvidenceSettings is independent of the general settings form.
type PoisonEvidenceSettings struct {
	EvidenceEnabled bool   `json:"evidence_enabled"`
	EvidenceDir     string `json:"evidence_dir"`
}

type PoisonEvidenceSettingsUpdate struct {
	EvidenceEnabled *bool   `json:"evidence_enabled"`
	EvidenceDir     *string `json:"evidence_dir"`
}

func (s *SettingService) GetPoisonEvidenceSettings(ctx context.Context) (*PoisonEvidenceSettings, error) {
	values, err := s.GetRawSettings(ctx, []string{poisonEvidenceEnabledKey, poisonEvidenceDirKey})
	if err != nil {
		return nil, fmt.Errorf("read poison evidence settings: %w", err)
	}
	out := &PoisonEvidenceSettings{EvidenceDir: poisonEvidenceDefaultDir}
	out.EvidenceEnabled = strings.EqualFold(strings.TrimSpace(values[poisonEvidenceEnabledKey]), "true") || values[poisonEvidenceEnabledKey] == "1"
	if value := strings.TrimSpace(values[poisonEvidenceDirKey]); value != "" {
		out.EvidenceDir = value
	}
	return out, nil
}

func (s *SettingService) UpdatePoisonEvidenceSettings(ctx context.Context, in PoisonEvidenceSettingsUpdate) error {
	updates := map[string]string{}
	if in.EvidenceEnabled != nil {
		updates[poisonEvidenceEnabledKey] = strconv.FormatBool(*in.EvidenceEnabled)
	}
	if in.EvidenceDir != nil {
		value := strings.TrimSpace(*in.EvidenceDir)
		if value == "" {
			return fmt.Errorf("evidence_dir cannot be empty")
		}
		updates[poisonEvidenceDirKey] = value
	}
	if len(updates) == 0 {
		return nil
	}
	if err := s.settingRepo.SetMultiple(ctx, updates); err != nil {
		return fmt.Errorf("save poison evidence settings: %w", err)
	}
	if s.onUpdate != nil {
		s.onUpdate()
	}
	return nil
}
