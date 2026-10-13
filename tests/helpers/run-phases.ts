/** The phase names /mycelink:run lists (`### Phase n — name`), in order. */
export function runPhases(text: string): string[] {
  return [...text.matchAll(/^### Phase \d+ — ([a-z]+)/gm)].map((m) => m[1] as string);
}
