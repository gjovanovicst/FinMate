import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/** Global so every feature module can inject the guarded client without re-importing. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
