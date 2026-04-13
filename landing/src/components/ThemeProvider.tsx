// summary: Owns the landing application theme context and persisted theme selection.
// FEATURE: Landing light and dark theme state with persistence.
// inputs: Child React nodes, persisted theme storage, and system theme signals.
// outputs: Theme context values and provider-wrapped landing UI state.
"use client";

import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Purpose: Provide the shared landing theme context and persist the chosen color mode.
// Inputs: The child React node tree that consumes the landing theme context.
// Returns/Effects: Returns a provider-wrapped subtree with persisted theme state.
export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setTheme] = useState<Theme>("light");
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        const stored = localStorage.getItem("theme") as Theme | null;
        if (stored) {
            setTheme(stored);
        } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
            setTheme("dark");
        }
    }, []);

    useEffect(() => {
        if (mounted) {
            document.documentElement.setAttribute("data-theme", theme);
            localStorage.setItem("theme", theme);
        }
    }, [theme, mounted]);

    const toggleTheme = () => {
        setTheme((prev: Theme) => (prev === "light" ? "dark" : "light"));
    };

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

// Purpose: Expose the shared landing theme context to interactive client components.
// Inputs: No direct inputs beyond the nearest ThemeProvider in the React tree.
// Returns/Effects: Returns the active theme state and toggle callback for landing components.
export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        return { theme: "light" as Theme, toggleTheme: () => { } };
    }
    return context;
}
