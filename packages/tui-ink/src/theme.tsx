import { createContext, type ReactNode, useContext } from "react";

/** Styling by theme token; the app passes its theme, so the kit never names concrete colors. */
export interface InkTheme<Token extends string = string> {
	fg(token: Token, text: string): string;
	bold(text: string): string;
}

const plainTheme: InkTheme = { fg: (_token, text) => text, bold: (text) => text };

const ThemeContext = createContext<InkTheme>(plainTheme);

export function ThemeProvider({ theme, children }: { theme: InkTheme; children: ReactNode }): ReactNode {
	return <ThemeContext value={theme}>{children}</ThemeContext>;
}

export function useTheme<Token extends string = string>(): InkTheme<Token> {
	return useContext(ThemeContext) as InkTheme<Token>;
}
