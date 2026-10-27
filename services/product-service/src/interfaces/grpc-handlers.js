import { requireActor } from '../../../../shared/errors.js';

export function productHandlers(application) {
  return {
    ListProducts: async (_input, actor) => { requireActor(actor); return application.list(); },
    GetProduct: async (input, actor) => { requireActor(actor); return application.get(input); },
    CreateProduct: async (input, actor) => { requireActor(actor, ['ADMIN']); return application.create(input); },
    UpdateProduct: async (input, actor) => { requireActor(actor, ['ADMIN']); return application.update(input); },
    DeleteProduct: async (input, actor) => { requireActor(actor, ['ADMIN']); return application.remove(input); },
    ApplyInventory: async (input, actor) => { requireActor(actor, ['SYSTEM', 'ADMIN']); return application.apply(input); },
    GetInventoryOperation: async (input, actor) => { requireActor(actor, ['SYSTEM', 'ADMIN']); return application.operation(input); },
    CancelInventory: async (input, actor) => { requireActor(actor, ['SYSTEM', 'ADMIN']); return application.cancel(input); },
  };
}
