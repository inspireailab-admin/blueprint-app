// Archive extraction for the uv release tarballs / zips. uv ships a
// single binary inside the archive; we walk the archive, find the
// binary entry, and write it to the configured uv path.
//
// Author: Amar Mond.
package pyruntime

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// extractUvFromZip pulls the uv.exe entry out of a Windows zip release.
func extractUvFromZip(archivePath, outPath string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open zip: %w", err)
	}
	defer r.Close()
	for _, f := range r.File {
		base := path.Base(f.Name)
		if strings.EqualFold(base, "uv.exe") {
			in, err := f.Open()
			if err != nil {
				return err
			}
			defer in.Close()
			return writeFile(outPath, in)
		}
	}
	return fmt.Errorf("uv.exe not found in archive")
}

// extractUvFromTarGz pulls the uv binary out of a Unix tar.gz release.
func extractUvFromTarGz(archivePath, outPath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gunzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := path.Base(hdr.Name)
		if base == "uv" {
			return writeFile(outPath, tr)
		}
	}
	return fmt.Errorf("uv binary not found in archive")
}

func writeFile(dst string, src io.Reader) error {
	if err := os.MkdirAll(path.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}
