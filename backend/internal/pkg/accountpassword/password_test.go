package accountpassword

import (
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestHashAndVerifyArgon2id(t *testing.T) {
	const password = "correct horse battery staple"

	encoded, err := Hash(password)
	if err != nil {
		t.Fatalf("Hash() error = %v", err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal("Hash() used an unexpected Argon2id parameter set")
	}
	if !Verify(password, encoded) {
		t.Fatal("Verify() rejected the password used to create the hash")
	}
	if Verify(password+"!", encoded) {
		t.Fatal("Verify() accepted a different password")
	}
}

func TestHashAndVerifyAcceptPublicPasswordBoundaries(t *testing.T) {
	passwords := []string{
		"123456",
		strings.Repeat("界", 256),
	}
	for _, password := range passwords {
		encoded, err := Hash(password)
		if err != nil {
			t.Fatal("Hash() rejected a password within the resource limit")
		}
		if !Verify(password, encoded) {
			t.Fatal("Verify() rejected a password accepted by Hash()")
		}
	}
}

func TestHashAndVerifyPreservePasswordBytes(t *testing.T) {
	const password = " 123456 "
	encoded, err := Hash(password)
	if err != nil {
		t.Fatal("Hash() rejected a password with significant surrounding bytes")
	}
	if !Verify(password, encoded) {
		t.Fatal("Verify() rejected the exact password bytes")
	}
	if Verify("123456", encoded) {
		t.Fatal("Verify() accepted a trimmed password")
	}
}

func TestHashUsesIndependentRandomSalts(t *testing.T) {
	const password = "synthetic-password"

	first, err := Hash(password)
	if err != nil {
		t.Fatal("first Hash() call failed")
	}
	second, err := Hash(password)
	if err != nil {
		t.Fatal("second Hash() call failed")
	}
	if first == second {
		t.Fatal("Hash() reused a salt")
	}
	if !Verify(password, first) || !Verify(password, second) {
		t.Fatal("Verify() rejected a hash produced by Hash()")
	}
}

func TestVerifyAcceptsLegacyBcryptVersions(t *testing.T) {
	const password = "synthetic-legacy-password"
	legacyHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal("failed to synthesize bcrypt fixture")
	}
	bcryptHash2a := string(legacyHash)
	versions := []string{
		bcryptHash2a,
		strings.Replace(bcryptHash2a, "$2a$", "$2b$", 1),
		strings.Replace(bcryptHash2a, "$2a$", "$2y$", 1),
	}
	for _, encoded := range versions {
		if !Verify(password, encoded) {
			t.Fatal("Verify() rejected a supported legacy bcrypt version")
		}
	}
	if Verify("synthetic-wrong-password", bcryptHash2a) {
		t.Fatal("Verify() accepted the wrong legacy bcrypt password")
	}
	invalidCost := strings.Replace(bcryptHash2a, "$04$", "$32$", 1)
	if Verify(password, invalidCost) {
		t.Fatal("Verify() accepted a bcrypt cost outside the native range")
	}
}

func TestVerifyRejectsMalformedArgon2idBeforeKDF(t *testing.T) {
	const validSalt = "MTIzNDU2Nzg5MGFiY2RlZg"
	const validKey = "MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY"
	malformed := []string{
		"$argon2id$v=18$m=19456,t=2,p=1$" + validSalt + "$" + validKey,
		"$argon2id$v=19$m=1,t=2,p=1$" + validSalt + "$" + validKey,
		"$argon2id$v=19$m=19456,t=2,p=2$" + validSalt + "$" + validKey,
		"$argon2id$v=19$m=4294967295,t=2,p=1$" + validSalt + "$" + validKey,
		"$argon2id$v=19$m=19456,t=2,p=1$not-base64$" + validKey,
		"$scrypt$v=19$m=19456,t=2,p=1$" + validSalt + "$" + validKey,
	}
	for _, encoded := range malformed {
		if Verify("synthetic-password", encoded) {
			t.Fatal("Verify() accepted malformed or excessive Argon2id parameters")
		}
	}
}

func TestHashAndVerifyRejectOversizedPasswordConsistently(t *testing.T) {
	password := strings.Repeat("x", MaxPasswordBytes+1)
	if _, err := Hash(password); err == nil {
		t.Fatal("Hash() accepted a password beyond the resource limit")
	}
	if Verify(password, "$argon2id$v=19$m=19456,t=2,p=1$MTIzNDU2Nzg5MGFiY2RlZg$MTIzNDU2Nzg5MGFiY2RlZjEyMzQ1Njc4OTBhYmNkZWY") {
		t.Fatal("Verify() accepted a password beyond the resource limit")
	}
}

func TestVerifyArgon2idSourceVector(t *testing.T) {
	const (
		password = "synthetic-source-password"
		encoded  = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$GjMMYXPor8fvNw656Q3DI9v/0UeSRv4rV/3Unsmumfw"
	)
	if !Verify(password, encoded) {
		t.Fatal("Verify() rejected the independent Argon2id source vector")
	}
	if Verify("synthetic-source-wrong-password", encoded) {
		t.Fatal("Verify() accepted the wrong password for the source vector")
	}
}

func TestVerifyArgon2idIsSafeForConcurrentCalls(t *testing.T) {
	const password = "synthetic-concurrent-password"
	encoded, err := Hash(password)
	if err != nil {
		t.Fatal("Hash() failed")
	}

	const workers = 4
	var wg sync.WaitGroup
	results := make(chan bool, workers)
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			results <- Verify(password, encoded)
		}()
	}
	wg.Wait()
	close(results)
	for ok := range results {
		if !ok {
			t.Fatal("concurrent Verify() rejected a valid password")
		}
	}
}
