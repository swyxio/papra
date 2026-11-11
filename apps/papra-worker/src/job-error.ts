export class JobError extends Error {
  constructor(
    public code: string,
    public permanent = false,
  ) {
    super(code);
  }
}
