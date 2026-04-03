// summary: Renders the animated girl-magician mascot as a transparent ASCII sprite.
// FEATURE: keeps palette-indexed frame masks derived from the reference images and converts them into colored terminal art.
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

var magicianFrames = []string{
	`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSEESSSSEESRWK
KWRSEESSSSEESRWK
..KWWSSSSSSWWK..
...KWWWWWWWWK...
...KWGGGGGGWK...
..KWRWGGGGWRWK..
..KWRWWWWWWRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`,
	`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSIISSSSSIISRWK
KWRSIISSSSSIISRWK
..KWWSSSSSSWWK..
...KWWWWWWWWK...
...KWGGGGGGWK...
..KWRWGGGGWRWK..
..KWRWWWWWWRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`,
	`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSEESSSSEESRWK
KWRSEESSSSEESRWK
..KWWSSSSSRRWK..
...KWWWWWRRWK...
...KWGGGRRRWK...
..KWRWGSRRRRWK..
..KWRWWRRRRRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`,
	mirrorMaskedFrame(`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSEESSSSEESRWK
KWRSEESSSSEESRWK
..KWWSSSSSRRWK..
...KWWWWWRRWK...
...KWGGGRRRWK...
..KWRWGSRRRRWK..
..KWRWWRRRRRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`),
	`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSEESSSSIISRWK
KWRSEESSSSEESRWK
..KWWSSSSSSWWK..
...KWWWWWWWWK...
...KWGGGGGGWK...
..KWRWGGGGWRWK..
..KWRWWWWWWRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`,
	mirrorMaskedFrame(`.......KK.......
.....KKWWKK.....
....KWWWWWWK....
...KWWRRRRWWK...
..KWWRHHHHRWWK..
..KWRRSSSSRRWK..
KWRSEESSSSIISRWK
KWRSEESSSSEESRWK
..KWWSSSSSSWWK..
...KWWWWWWWWK...
...KWGGGGGGWK...
..KWRWGGGGWRWK..
..KWRWWWWWWRWK..
.KWWRWWWWWWRWWK.
.KRRRWWWWWWRRRK.
..KKRRRRRRRRKK..`),
}

var magicianSpritePalette = map[rune]lipgloss.Color{
	'K': lipgloss.Color("#2b3139"),
	'W': lipgloss.Color("#ffffff"),
	'R': lipgloss.Color("#ed145b"),
	'S': lipgloss.Color("#ffd8bf"),
	'H': lipgloss.Color("#e6bf6f"),
	'E': lipgloss.Color("#d0d3d8"),
	'I': lipgloss.Color("#d0d3d8"),
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

func mirrorMaskedFrame(frame string) string {
	rows := frameTokenRows(frame)
	mirrored := make([]string, 0, len(rows))
	for _, row := range rows {
		tokens := []rune(row)
		for left, right := 0, len(tokens)-1; left < right; left, right = left+1, right-1 {
			tokens[left], tokens[right] = tokens[right], tokens[left]
		}
		mirrored = append(mirrored, string(tokens))
	}
	return strings.Join(mirrored, "\n")
}

func dominantToken(counts map[rune]int) rune {
	dominant := '.'
	maxCount := 0
	for _, token := range []rune{'K', 'W', 'R', 'S', 'H', 'E', 'I', 'G'} {
		if counts[token] > maxCount {
			dominant = token
			maxCount = counts[token]
		}
	}
	return dominant
}

func denseGlyphForToken(token rune) rune {
	switch token {
	case 'K':
		return '#'
	case 'W':
		return '@'
	case 'R':
		return '%'
	case 'S':
		return 'o'
	case 'H':
		return '*'
	case 'E':
		return '='
	case 'I':
		return '-'
	case 'G':
		return '+'
	default:
		return '#'
	}
}

func asciiGlyphForBlock(mask int, token rune, count int) rune {
	if token == 'I' {
		return '-'
	}
	switch mask {
	case 0:
		return ' '
	case 1:
		return '`'
	case 2:
		return '\''
	case 3:
		return '-'
	case 4:
		return '.'
	case 5:
		return '|'
	case 6:
		return '/'
	case 7:
		return denseGlyphForToken(token)
	case 8:
		return ','
	case 9:
		return '\\'
	case 10:
		return '|'
	case 11:
		return denseGlyphForToken(token)
	case 12:
		return '_'
	case 13:
		return denseGlyphForToken(token)
	case 14:
		return denseGlyphForToken(token)
	case 15:
		return denseGlyphForToken(token)
	default:
		if count >= 3 {
			return denseGlyphForToken(token)
		}
		return ':'
	}
}

func renderASCIISprite(frame string, styled bool) string {
	pixels := expandFrameTokens(frame, 1, 1)
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
		for x := 0; x < width; x += 2 {
			mask := 0
			counts := make(map[rune]int)
			samples := [4]rune{
				pixels[y][x],
				pixels[y][min(x+1, width-1)],
				pixels[y+1][x],
				pixels[y+1][min(x+1, width-1)],
			}
			for index, token := range samples {
				if !opaqueToken(token) {
					continue
				}
				mask |= 1 << index
				counts[token]++
			}
			if mask == 0 {
				builder.WriteRune(' ')
				continue
			}
			token := dominantToken(counts)
			glyph := asciiGlyphForBlock(mask, token, counts[token])
			if !styled {
				builder.WriteRune(glyph)
				continue
			}
			color, ok := magicianSpritePalette[token]
			if !ok {
				builder.WriteRune(glyph)
				continue
			}
			builder.WriteString(lipgloss.NewStyle().Foreground(color).Render(string(glyph)))
		}
		rendered = append(rendered, builder.String())
	}
	return strings.Join(rendered, "\n")
}

func renderMagicianASCII(frame string) string {
	return renderASCIISprite(frame, false)
}

func renderMagician(frame string, width int) string {
	return centerBlock(renderASCIISprite(frame, true), max(12, width))
}
