import { Global, Module, type DynamicModule } from '@nestjs/common';

import { CONFIG, loadConfig, type AppConfig } from './config';

/**
 * Provides the validated {@link AppConfig} under the {@link CONFIG} token.
 *
 * `loadConfig()` runs when the module is created, so invalid configuration fails at boot.
 */
@Global()
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: CONFIG, useValue: config }],
      exports: [{ provide: CONFIG, useValue: config }],
    };
  }
}
