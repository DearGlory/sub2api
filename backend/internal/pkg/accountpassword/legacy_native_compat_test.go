package accountpassword

import (
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestLegacyBcryptNativeCompatibility(t *testing.T) {
	const password = "synthetic-cost-compatibility"
	highCost, err := bcrypt.GenerateFromPassword([]byte(password), 15)
	if err != nil {
		t.Fatal("synthetic high-cost fixture generation failed")
	}
	if !Verify(password, string(highCost)) {
		t.Fatal("valid legacy bcrypt cost 15 was rejected")
	}
	legacy, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal("synthetic legacy fixture generation failed")
	}
	noMinor := strings.Replace(string(legacy), "$2a$", "$2$", 1)
	if bcrypt.CompareHashAndPassword([]byte(noMinor), []byte(password)) != nil {
		t.Fatal("native bcrypt fixture did not validate")
	}
	if !Verify(password, noMinor) {
		t.Fatal("native-supported bcrypt format was rejected")
	}
}
