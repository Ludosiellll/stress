import { describe } from 'vitest';
import { MemoryRepository } from './memoryRepository';
import { repositoryContract } from './repository.contract';

describe('MemoryRepository', () => {
  repositoryContract(() => Promise.resolve(new MemoryRepository()));
});
