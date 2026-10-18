package config

import (
	"reflect"
	"testing"
)

func TestLoadPasswordCopyDefaultsEnabledWithDirectory(t *testing.T) {
	resetViperWithJWTSecret(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	field := reflect.ValueOf(cfg).Elem().FieldByName("PasswordCopy")
	if !field.IsValid() {
		t.Fatal("Config.PasswordCopy is missing")
	}
	enabled := field.FieldByName("Enabled")
	directory := field.FieldByName("Directory")
	if !enabled.IsValid() || !directory.IsValid() {
		t.Fatal("Config.PasswordCopy must expose Enabled and Directory")
	}
	if !enabled.Bool() {
		t.Fatal("password copy must be enabled by default")
	}
	if directory.String() == "" {
		t.Fatal("password copy default directory must not be empty")
	}
}

func TestLoadPasswordCopyCanBeDisabledByEnvironment(t *testing.T) {
	resetViperWithJWTSecret(t)
	t.Setenv("PASSWORD_COPY_ENABLED", "false")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}

	field := reflect.ValueOf(cfg).Elem().FieldByName("PasswordCopy")
	if !field.IsValid() {
		t.Fatal("Config.PasswordCopy is missing")
	}
	enabled := field.FieldByName("Enabled")
	if !enabled.IsValid() {
		t.Fatal("Config.PasswordCopy.Enabled is missing")
	}
	if enabled.Bool() {
		t.Fatal("PASSWORD_COPY_ENABLED=false must disable password copies")
	}
}
