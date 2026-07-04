package main

import (
	"reflect"
	"testing"
)

func TestServeSplitArgs(t *testing.T) {
	cases := []struct {
		name string
		opts ServeOptions
		want []string
	}{
		{
			name: "single-gpu / unset → no split flags",
			opts: ServeOptions{ModelID: "m", Quant: "q4"},
			want: nil,
		},
		{
			name: "layer split, main-gpu default (0) omitted",
			opts: ServeOptions{SplitMode: "layer", TensorSplit: []float64{0.75, 0.25}},
			want: []string{"--split-mode", "layer", "--tensor-split", "0.75,0.25"},
		},
		{
			name: "row split with non-default main-gpu",
			opts: ServeOptions{SplitMode: "row", TensorSplit: []float64{0.5, 0.5}, MainGPU: 1},
			want: []string{"--split-mode", "row", "--tensor-split", "0.5,0.5", "--main-gpu", "1"},
		},
		{
			name: "unknown split mode is ignored",
			opts: ServeOptions{SplitMode: "bogus"},
			want: nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := serveSplitArgs(c.opts)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("serveSplitArgs() = %v, want %v", got, c.want)
			}
		})
	}
}
