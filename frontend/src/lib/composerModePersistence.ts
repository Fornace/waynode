export class ComposerModePersistence {
  private pending: Promise<void> = Promise.resolve();

  save(operation: () => Promise<unknown>): Promise<void> {
    const current = this.pending.then(operation).then(() => undefined);
    this.pending = current.catch(() => undefined);
    return current;
  }

  beforeSubmit(): Promise<void> {
    return this.pending;
  }
}
