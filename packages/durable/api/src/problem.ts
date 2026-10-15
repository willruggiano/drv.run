export class Problem extends Error {
  readonly status: number;
  readonly allow: string | undefined;
  constructor(status: number, allow?: string) {
    super();
    this.status = status;
    this.allow = allow;
  }
}
