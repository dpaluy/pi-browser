#!/bin/sh
set -eu

cd "$(dirname "$0")/../extension/icons"

render() {
  state=$1 tile=$2 edge=$3 slash=${4:-none}
  for size in 16 32 48 128; do
    sed -e "s/@TILE@/$tile/g" -e "s/@EDGE@/$edge/g" -e "s/@SLASH@/$slash/g" pi.svg |
      rsvg-convert --width "$size" --height "$size" --output "$state-$size.png"
  done
}

render off     '#59616D' '#737D8A'
render ready   '#465E9D' '#647ABD'
render active  '#007A64' '#259781'
render working '#A44B16' '#C67730'
render disabled '#40404B' '#777384' inline
