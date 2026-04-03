// summary: Renders the animated girl-magician mascot as a transparent ASCII sprite.
// FEATURE: keeps palette-indexed frame masks derived from the reference images and converts them into colored terminal art.
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var magicianFrames = []string{
	`......KK......
....KKWWKK....
...KWWWWWWK...
..KWWRRRRWWK..
.KWWRRRRRRWWK.
.KWRRHHHHRRWK.
KWWRSSSSSSRWWK
KWRSSEEEESSRWK
KWRSSEEEESSRWK
.KWWSSSSSSWWK.
..KWWWWWWWWK..
..KWGGGGGGWK..
.KWRWGGGGWRWK.
.KWRWWWWWWRWK.
KWWRWWWWWWRWWK
KRRRWWWWWWRRRK`,
	`......KK......
....KKWWKK....
...KWWWWWWK...
..KWWRRRRWWK..
.KWWRRRRRRWWK.
.KWRRHHHHRRWK.
KWWRSSSSSSRWWK
KWRSSEEEESSRWK
KWRSSEEEESSRWK
.KWWSSSSSSWWK.
..KWWWWWWWWK..
.KWGGGGGGGGWK.
KWRWGGGGGGWRWK
.KWRWWWWWWRWK.
KWWRWWWWWWRWWK
.RRRWWWWWWRRR.`,
	`......KK......
....KKWWKK....
...KWWWWWWK...
..KWWRRRRWWK..
.KWWRRRRRRWWK.
.KWRRHHHHRRWK.
KWWRSSSSSSRWWK
KWRSSEEEESSRWK
KWRSSEEEESRRWK
.KWWSSSSWRRWK.
..KWWWWWSRRK..
..KWGGGSRRWK..
.KWRWGSRRRWK..
.KWRWWRRRRWK..
KWWRWWWWWWRWWK
KRRRWWWWWWRRRK`,
}

var magicianSpritePalette = map[rune]lipgloss.Color{
	'K': lipgloss.Color("#2b3139"),
	'W': lipgloss.Color("#ffffff"),
	'R': lipgloss.Color("#ed145b"),
	'S': lipgloss.Color("#ffd8bf"),
	'H': lipgloss.Color("#e6bf6f"),
	'E': lipgloss.Color("#d0d3d8"),
	'G': lipgloss.Color("#e2e2e4"),
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

func opaqueToken(token rune) bool {
	return token != '.'
}

func renderHalfBlockSprite(frame string, styled bool) string {
	pixels := expandFrameTokens(frame, 2, 1)
	if len(pixels) == 0 {
		return ""
	}
	if len(pixels)%2 != 0 {
		padding := make([]rune, len(pixels[0]))
		for index := range padding {
			padding[index] = '.'
		}
		pixels = append(pixels, padding)
	}
	height := len(pixels)
	width := len(pixels[0])
	rendered := make([]string, 0, height/2)
	for y := 0; y < height; y += 2 {
		var builder strings.Builder
		for x := 0; x < width; x++ {
			topToken := pixels[y][x]
			bottomToken := pixels[y+1][x]
			topOpaque := opaqueToken(topToken)
			bottomOpaque := opaqueToken(bottomToken)
			if !topOpaque && !bottomOpaque {
				builder.WriteRune(' ')
				continue
			}
			if !styled {
				switch {
				case topOpaque && bottomOpaque && topToken == bottomToken:
					builder.WriteRune('█')
				case topOpaque && !bottomOpaque:
					builder.WriteRune('▀')
				case !topOpaque && bottomOpaque:
					builder.WriteRune('▄')
				default:
					builder.WriteRune('▀')
				}
				continue
			}
			switch {
			case topOpaque && bottomOpaque && topToken == bottomToken:
				builder.WriteString(lipgloss.NewStyle().Foreground(magicianSpritePalette[topToken]).Render("█"))
			case topOpaque && !bottomOpaque:
				builder.WriteString(lipgloss.NewStyle().Foreground(magicianSpritePalette[topToken]).Render("▀"))
			case !topOpaque && bottomOpaque:
				builder.WriteString(lipgloss.NewStyle().Foreground(magicianSpritePalette[bottomToken]).Render("▄"))
			default:
				topColor, topOK := magicianSpritePalette[topToken]
				bottomColor, bottomOK := magicianSpritePalette[bottomToken]
				if !topOK || !bottomOK {
					builder.WriteRune('▀')
					continue
				}
				builder.WriteString(lipgloss.NewStyle().Foreground(topColor).Background(bottomColor).Render("▀"))
				continue
			}
		}
		rendered = append(rendered, builder.String())
	}
	return strings.Join(rendered, "\n")
}

func renderMagicianASCII(frame string) string {
	return renderHalfBlockSprite(frame, false)
}

func renderMagician(frame string, width int) string {
	return centerBlock(renderHalfBlockSprite(frame, true), max(12, width))
}
