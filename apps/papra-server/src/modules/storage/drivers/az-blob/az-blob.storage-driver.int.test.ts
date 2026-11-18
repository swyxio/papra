import { AzuriteContainer } from '@testcontainers/azurite';
import { beforeAll, describe } from 'vitest';
import { TEST_CONTAINER_IMAGES } from '../../../../../test/containers/images';
import { runDriverTestSuites } from '../drivers.test-suite';
import { azBlobStorageDriverFactory } from './az-blob.storage-driver';

describe('az-blob storage-driver', () => {
  let driver: ReturnType<typeof azBlobStorageDriverFactory>;

  beforeAll(async () => {
    const container = await new AzuriteContainer(TEST_CONTAINER_IMAGES.AZURITE)
      .withInMemoryPersistence()
      .start();
    try {
      driver = azBlobStorageDriverFactory({
        connectionString: container.getConnectionString(),
        containerName: 'test-container',
        accountName: '',
        accountKey: '',
      });
      await driver.getClient().createContainer('test-container');
    } catch (error) {
      await container.stop();
      throw error;
    }
    return async () => {
      await container.stop();
    };
  }, 120_000);

  runDriverTestSuites({
    // Each test uses a unique object key in the suite's blob container.
    createDriver: async () => ({ driver, [Symbol.asyncDispose]: async () => {} }),
  });
});
