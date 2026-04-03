// summary: Renders the animated girl-magician mascot as a transparent ASCII sprite.
// FEATURE: keeps palette-indexed frame masks derived from the reference images and converts them into colored terminal art.
package ui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

const (
	magicianVirtualCanvasSize = 64
	magicianDisplayRows       = 8
	magicianDefaultColumns    = 20
	magicianMinimumColumns    = 14
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

func frameTokenBounds(frame string) (int, int) {
	rows := frameTokenRows(frame)
	height := len(rows)
	width := 0
	for _, row := range rows {
		width = max(width, len([]rune(row)))
	}
	return width, height
}

func opaqueToken(token rune) bool {
	return token != '.'
}

func blankTokenRow(width int) []rune {
	row := make([]rune, width)
	for index := range row {
		row[index] = '.'
	}
	return row
}

func scaledFrameCanvas(frame string, size int) [][]rune {
	sourceRows := frameTokenRows(frame)
	sourceWidth, sourceHeight := frameTokenBounds(frame)
	canvas := make([][]rune, size)
	for index := range canvas {
		canvas[index] = blankTokenRow(size)
	}
	if sourceWidth == 0 || sourceHeight == 0 {
		return canvas
	}
	scale := max(1, min(size/sourceWidth, size/sourceHeight))
	scaledWidth := sourceWidth * scale
	scaledHeight := sourceHeight * scale
	xOffset := max(0, (size-scaledWidth)/2)
	yOffset := max(0, (size-scaledHeight)/2)
	for sourceY, row := range sourceRows {
		tokens := []rune(row)
		for sourceX, token := range tokens {
			for deltaY := 0; deltaY < scale; deltaY++ {
				for deltaX := 0; deltaX < scale; deltaX++ {
					canvasY := yOffset + sourceY*scale + deltaY
					canvasX := xOffset + sourceX*scale + deltaX
					if canvasY >= size || canvasX >= size {
						continue
					}
					canvas[canvasY][canvasX] = token
				}
			}
		}
	}
	return canvas
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

func dominantNonOutlineToken(counts map[rune]int) rune {
	dominant := '.'
	maxCount := 0
	for _, token := range []rune{'W', 'R', 'S', 'H', 'E', 'I', 'G'} {
		if counts[token] > maxCount {
			dominant = token
			maxCount = counts[token]
		}
	}
	return dominant
}

func representativeToken(counts map[rune]int, opaque int) rune {
	switch {
	case counts['I']*4 >= opaque:
		return 'I'
	case counts['E']*4 >= opaque:
		return 'E'
	case counts['R']*3 >= opaque:
		return 'R'
	case counts['H']*3 >= opaque:
		return 'H'
	}
	if opaque-counts['K'] > 0 {
		if nonOutline := dominantNonOutlineToken(counts); nonOutline != '.' {
			return nonOutline
		}
	}
	return dominantToken(counts)
}

func glyphRampForToken(token rune) []rune {
	switch token {
	case 'K':
		return []rune(" .'`:;|/tiL#@")
	case 'W':
		return []rune(" .,:-=+*#@")
	case 'R':
		return []rune(" .,:-+xX%#")
	case 'S':
		return []rune(" .`':;coO0")
	case 'H':
		return []rune(" .`':;*xX#")
	case 'E':
		return []rune(" .-~=oO0Q")
	case 'I':
		return []rune("__--")
	case 'G':
		return []rune(" .,:-=+*#")
	default:
		return []rune(" .,:-=+*#@")
	}
}

func pairedBandGlyph(token rune, opaque int, total int, topOpaque int, bottomOpaque int) rune {
	if opaque <= 0 || total <= 0 {
		return ' '
	}
	if token == 'I' {
		return '_'
	}
	if token == 'E' {
		return '0'
	}
	density := float64(opaque) / float64(total)
	if density < 0.12 {
		return '.'
	}
	if density < 0.22 && (topOpaque == 0 || bottomOpaque == 0) {
		return ':'
	}
	switch token {
	case 'K':
		if density < 0.35 {
			return ':'
		}
		return '#'
	case 'W':
		if density < 0.35 {
			return '+'
		}
		return '@'
	case 'R':
		if density < 0.35 {
			return 'x'
		}
		return '%'
	case 'S':
		if density < 0.35 {
			return 'c'
		}
		return 'o'
	case 'H':
		if density < 0.35 {
			return ';'
		}
		return '*'
	case 'G':
		if density < 0.35 {
			return '='
		}
		return '+'
	}
	return glyphRampForToken(token)[len(glyphRampForToken(token))-1]
}

func renderASCIISprite(frame string, styled bool, visibleColumns int) string {
	canvas := scaledFrameCanvas(frame, magicianVirtualCanvasSize)
	if len(canvas) == 0 {
		return ""
	}
	columns := min(magicianDefaultColumns, max(magicianMinimumColumns, visibleColumns))
	rendered := make([]string, 0, magicianDisplayRows)
	for row := 0; row < magicianDisplayRows; row++ {
		yStart := row * magicianVirtualCanvasSize / magicianDisplayRows
		yEnd := (row + 1) * magicianVirtualCanvasSize / magicianDisplayRows
		if yEnd <= yStart {
			yEnd = yStart + 1
		}
		var builder strings.Builder
		for column := 0; column < columns; column++ {
			xStart := column * magicianVirtualCanvasSize / columns
			xEnd := (column + 1) * magicianVirtualCanvasSize / columns
			if xEnd <= xStart {
				xEnd = xStart + 1
			}
			counts := make(map[rune]int)
			opaque := 0
			total := 0
			topOpaque := 0
			bottomOpaque := 0
			halfHeight := max(1, (yEnd-yStart)/2)
			for y := yStart; y < yEnd; y++ {
				for x := xStart; x < xEnd; x++ {
					total++
					token := canvas[y][x]
					if !opaqueToken(token) {
						continue
					}
					opaque++
					counts[token]++
					if y-yStart < halfHeight {
						topOpaque++
					} else {
						bottomOpaque++
					}
				}
			}
			if opaque == 0 {
				builder.WriteRune(' ')
				continue
			}
			token := representativeToken(counts, opaque)
			glyph := pairedBandGlyph(token, opaque, total, topOpaque, bottomOpaque)
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
	return renderASCIISprite(frame, false, magicianDefaultColumns)
}

func renderMagician(frame string, width int) string {
	targetColumns := min(magicianDefaultColumns, max(magicianMinimumColumns, width))
	return centerBlock(renderASCIISprite(frame, true, targetColumns), max(targetColumns, width))
}
