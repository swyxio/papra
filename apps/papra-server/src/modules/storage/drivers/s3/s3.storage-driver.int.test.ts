import { LocalstackContainer } from '@testcontainers/localstack';
import { beforeAll, describe } from 'vitest';
import { TEST_CONTAINER_IMAGES } from '../../../../../test/containers/images';
import { runDriverTestSuites } from '../drivers.test-suite';
import { s3StorageDriverFactory } from './s3.storage-driver';

describe('s3 storage-driver', () => {
  let driver: ReturnType<typeof s3StorageDriverFactory>;

  beforeAll(async () => {
    const container = await new LocalstackContainer(TEST_CONTAINER_IMAGES.LOCALSTACK).start();
    try {
      driver = s3StorageDriverFactory({
        accessKeyId: 'test',
        secretAccessKey: 'test',
        bucketName: 'test-bucket',
        region: 'eu-central-1',
        endpoint: container.getConnectionUri(),
        forcePathStyle: true,
      });
      await driver.getClient().createBucket();
    } catch (error) {
      await container.stop();
      throw error;
    }
    return async () => {
      await container.stop();
    };
  }, 120_000);

  runDriverTestSuites({
    // Each test uses a unique object key in the suite's bucket.
    createDriver: async () => ({ driver, [Symbol.asyncDispose]: async () => {} }),
  });
});
