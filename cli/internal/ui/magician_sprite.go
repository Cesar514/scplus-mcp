// summary: Renders the animated girl-magician mascot as a transparent ASCII sprite.
// FEATURE: keeps palette-indexed frame masks derived from the reference images and converts them into colored terminal art.
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var magicianFrames = []string{
	`....KKKK....
...KWWWWK...
..KWWWWWWK..
.KWWRRRRWWK.
KWRRRRRRRRWK
KWRSHHHHSRWK
WWRSSSSSSRWW
WWRSEEEESRWW
WWRSSSSSSRWW
.KWWSSSSWWK.
..KWWWWWWK..
..KWGGGGWK..
.KWRWGGWRWK.
.KWRWWWWRWK.
KWWRWWWWRWWK
KRRKKKKKKRRK`,
	`....KKKK....
...KWWWWK...
..KWWWWWWK..
.KWWRRRRWWK.
KWRRRRRRRRWK
KWRSHHHHSRWK
WWRSSSSSSRWW
WWRSGGGGSRWW
WWRSSSSSSRWW
..KWWSSSWWK.
.KWWWWWWWK..
.KWGGGGGGWK.
KWRWGGSGWRWK
.KWRWWWWRWK.
KWWRWWWWRWWK
.RRKKKKKKRR.`,
	`....KKKK....
...KWWWWK...
..KWWWWWWK..
.KWWRRRRWWK.
KWRRRRRRRRWK
KWRSHHHHSRWK
WWRSSSSSSRWW
WWRSEEEESRWW
WWRSSSSSRRWK
.KWWSSSWRRWK
..KWWWWSRRK.
..KWGGGSRWK.
.KWRWGSRRWK.
.KWRWWRRRWK.
KWWRWWWWRWWK
KRRKKKKKKRRK`,
}

var magicianSpritePalette = map[rune]lipgloss.Style{
	'K': lipgloss.NewStyle().Foreground(lipgloss.Color("236")),
	'W': lipgloss.NewStyle().Foreground(lipgloss.Color("255")),
	'R': lipgloss.NewStyle().Foreground(lipgloss.Color("197")),
	'S': lipgloss.NewStyle().Foreground(lipgloss.Color("223")),
	'H': lipgloss.NewStyle().Foreground(lipgloss.Color("221")),
	'E': lipgloss.NewStyle().Foreground(lipgloss.Color("250")),
	'G': lipgloss.NewStyle().Foreground(lipgloss.Color("252")),
}

var brailleDotBits = [4][2]int{
	{0x01, 0x08},
	{0x02, 0x10},
	{0x04, 0x20},
	{0x40, 0x80},
}

func frameTokenRows(frame string) []string {
	return strings.Split(frame, "\n")
}

func expandFrameTokens(frame string, xScale int, yScale int) [][]rune {
	rows := frameTokenRows(frame)
	expanded := make([][]rune, 0, len(rows)*yScale)
	for _, row := range rows {
		source := []rune(row)
		scaledRow := make([]rune, 0, len(source)*xScale)
		for _, token := range source {
			for repeat := 0; repeat < xScale; repeat++ {
				scaledRow = append(scaledRow, token)
			}
		}
		for repeat := 0; repeat < yScale; repeat++ {
			copied := make([]rune, len(scaledRow))
			copy(copied, scaledRow)
			expanded = append(expanded, copied)
		}
	}
	return expanded
}

func dominantToken(counts map[rune]int) rune {
	dominant := '.'
	maxCount := 0
	for _, token := range []rune{'K', 'W', 'R', 'S', 'H', 'E', 'G'} {
		if counts[token] > maxCount {
			dominant = token
			maxCount = counts[token]
		}
	}
	return dominant
}

func renderBrailleSprite(frame string, styled bool) string {
	pixels := expandFrameTokens(frame, 2, 2)
	if len(pixels) == 0 {
		return ""
	}
	height := len(pixels)
	width := len(pixels[0])
	rendered := make([]string, 0, height/4)
	for y := 0; y < height; y += 4 {
		var builder strings.Builder
		for x := 0; x < width; x += 2 {
			mask := 0
			counts := make(map[rune]int)
			for dy := 0; dy < 4; dy++ {
				for dx := 0; dx < 2; dx++ {
					token := pixels[y+dy][x+dx]
					if token == '.' {
						continue
					}
					mask |= brailleDotBits[dy][dx]
					counts[token]++
				}
			}
			if mask == 0 {
				builder.WriteRune(' ')
				continue
			}
			glyph := string(rune(0x2800 + mask))
			if !styled {
				builder.WriteString(glyph)
				continue
			}
			style, ok := magicianSpritePalette[dominantToken(counts)]
			if !ok {
				builder.WriteString(glyph)
				continue
			}
			builder.WriteString(style.Render(glyph))
		}
		rendered = append(rendered, builder.String())
	}
	return strings.Join(rendered, "\n")
}

func renderMagicianASCII(frame string) string {
	return renderBrailleSprite(frame, false)
}

func renderMagician(frame string, width int) string {
	return centerBlock(renderBrailleSprite(frame, true), max(12, width))
}
