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

var magicianSpritePalette = map[rune]string{
	'.': "  ",
	'K': lipgloss.NewStyle().Foreground(lipgloss.Color("236")).Render("##"),
	'W': lipgloss.NewStyle().Foreground(lipgloss.Color("255")).Render("@@"),
	'R': lipgloss.NewStyle().Foreground(lipgloss.Color("197")).Render("%%"),
	'S': lipgloss.NewStyle().Foreground(lipgloss.Color("223")).Render("oo"),
	'H': lipgloss.NewStyle().Foreground(lipgloss.Color("221")).Render("**"),
	'E': lipgloss.NewStyle().Foreground(lipgloss.Color("250")).Render("[]"),
	'G': lipgloss.NewStyle().Foreground(lipgloss.Color("252")).Render("::"),
}

var magicianPlainPalette = map[rune]string{
	'.': "  ",
	'K': "##",
	'W': "@@",
	'R': "%%",
	'S': "oo",
	'H': "**",
	'E': "[]",
	'G': "::",
}

func renderASCIIArtSprite(frame string, palette map[rune]string) string {
	rows := strings.Split(frame, "\n")
	rendered := make([]string, 0, len(rows))
	for _, row := range rows {
		var builder strings.Builder
		for _, token := range row {
			glyph, ok := palette[token]
			if !ok {
				glyph = palette['.']
			}
			builder.WriteString(glyph)
		}
		rendered = append(rendered, builder.String())
	}
	return strings.Join(rendered, "\n")
}

func renderMagicianASCII(frame string) string {
	return renderASCIIArtSprite(frame, magicianPlainPalette)
}

func renderMagician(frame string, width int) string {
	return centerBlock(renderASCIIArtSprite(frame, magicianSpritePalette), max(12, width))
}
