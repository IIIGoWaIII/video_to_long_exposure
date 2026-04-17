#! /usr/bin/bash

frame_rate=2

# Process command line options
while getopts "r:" opt; do
    case $opt in
        r) frame_rate=$OPTARG ;;
        \?) echo "Usage: $0 [-r frame_rate] input_file output_file"; exit 1 ;;
    esac
done

# Remove processed options from arguments
shift "$((OPTIND-1))"

if [ "$#" -lt 1 ]; then
    echo "Usage: $0 [-r frame_rate] input_file output_file"
    exit 1
fi

input_file="$1"

if [ "$#" -eq 2 ]; then
    output_file="$2"
else
    output_file="final.jpg"
fi

mkdir -p frames
mkdir -p aligned

rm frames/*
rm aligned/*

ffmpeg -i "$input_file" -r "$frame_rate" frames/%04d.png
/Applications/Hugin/tools_mac/align_image_stack frames/*.png -a aligned/a -v
convert aligned/*.tif -average "$output_file"

open "$output_file"