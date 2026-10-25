package poison

import (
	"bytes"
	"io"
	"os"
)

// This is a storage tier threshold, not a response-size limit. Large pending
// wire data spills to a per-request file instead of growing retained heap.
const wireMemoryThreshold = 256 * 1024

type wireSpool struct {
	memory []byte
	file   *os.File
	size   int64
}

func (s *wireSpool) append(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if s.file == nil && len(s.memory)+len(data) <= wireMemoryThreshold {
		s.memory = append(s.memory, data...)
		s.size += int64(len(data))
		return nil
	}
	if s.file == nil {
		f, err := os.CreateTemp("", "sub2api-poison-wire-*")
		if err != nil {
			return err
		}
		s.file = f
		if _, err = f.Write(s.memory); err != nil {
			s.close()
			return err
		}
		s.memory = nil
	}
	n, err := s.file.Write(data)
	s.size += int64(n)
	if err == nil && n != len(data) {
		err = io.ErrShortWrite
	}
	return err
}

func (s *wireSpool) spill() error {
	if s.file != nil {
		return nil
	}
	f, err := os.CreateTemp("", "sub2api-poison-wire-*")
	if err != nil {
		return err
	}
	s.file = f
	if _, err := f.Write(s.memory); err != nil {
		s.close()
		return err
	}
	s.memory = nil
	return nil
}

func (s *wireSpool) reader() io.Reader {
	if s.file != nil {
		return io.NewSectionReader(s.file, 0, s.size)
	}
	return bytes.NewReader(s.memory)
}

func (s *wireSpool) bytes() ([]byte, error) {
	if s.file == nil {
		return bytes.Clone(s.memory), nil
	}
	return io.ReadAll(s.reader())
}

func (s *wireSpool) readRange(offset, length int64) ([]byte, error) {
	if offset < 0 || length < 0 || offset > s.size-length {
		return nil, io.ErrUnexpectedEOF
	}
	if s.file != nil {
		return io.ReadAll(io.NewSectionReader(s.file, offset, length))
	}
	return bytes.Clone(s.memory[offset : offset+length]), nil
}

func (s *wireSpool) close() {
	if s.file != nil {
		name := s.file.Name()
		_ = s.file.Close()
		_ = os.Remove(name)
	}
	s.file = nil
	s.memory = nil
	s.size = 0
}
