import { StorageRequestError } from "@earendil-works/pi-durable";

export class Problem extends Error {
  readonly status: number;
  readonly allow: string | undefined;
  constructor(status: number, allow?: string) {
    super();
    this.status = status;
    this.allow = allow;
  }
}

// Only wrap read-only operations. StorageRequestError from commit/mint is fatal.
export async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StorageRequestError) throw new Problem(400);
    throw error;
  }
}
