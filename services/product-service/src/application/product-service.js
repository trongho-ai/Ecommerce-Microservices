import { positiveId } from '../../../../shared/errors.js';
import { normalizeItems, operationId, productInput } from '../domain/product.js';

export function productApplication(repository) {
  return {
    async list() { return { items: await repository.list() }; },
    async get(input) { return repository.get(positiveId(input.pid, 'pid')); },
    async create(input) { return repository.create(productInput(input)); },
    async update(input) { return repository.update(positiveId(input.pid, 'pid'), productInput(input, { partial: true })); },
    async remove(input) { return repository.remove(positiveId(input.pid, 'pid')); },
    async apply(input) {
      const id = operationId(input.operationId);
      const items = normalizeItems(input.items);
      return repository.apply(id, items, JSON.stringify(items));
    },
    async operation(input) { return repository.getOperation(operationId(input.operationId)); },
    async cancel(input) { return repository.cancel(operationId(input.operationId)); },
  };
}
