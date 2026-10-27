import { positiveId, requireActor, requireOwner } from '../../../../shared/errors.js';
import { validateCustomerUpdate, validateProvisioning } from '../domain/customer.js';

export function customerApplication(repository) {
  return {
    async get(input, actor) {
      const uid = positiveId(input.uid, 'uid');
      requireOwner(actor, uid);
      return repository.get(uid);
    },
    async membership(input, actor) {
      const uid = positiveId(input.uid, 'uid');
      requireOwner(actor, uid);
      return repository.membership(uid);
    },
    async update(input, actor) {
      return repository.update(validateCustomerUpdate(input, actor));
    },
    async ensure(input, actor) {
      requireActor(actor, ['SYSTEM', 'ADMIN']);
      return repository.ensure(validateProvisioning(input));
    },
  };
}
