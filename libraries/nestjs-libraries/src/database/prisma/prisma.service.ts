import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaD1 } from '@prisma/adapter-d1';
import { d1Bridge } from '@gitroom/nestjs-libraries/database/prisma/d1.bridge';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
      ],
      // Cloudflare deployment only (deploy/cloudflare): talk to D1 through the
      // Worker. Unset everywhere else, so the Postgres path is unchanged.
      ...(process.env.D1_BRIDGE_URL
        ? { adapter: new PrismaD1(d1Bridge(process.env.D1_BRIDGE_URL) as any) }
        : {}),
    });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

@Injectable()
export class PrismaRepository<T extends keyof PrismaService> {
  public model: Pick<PrismaService, T>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}

@Injectable()
export class PrismaTransaction {
  public model: Pick<PrismaService, '$transaction'>;
  constructor(private _prismaService: PrismaService) {
    this.model = this._prismaService;
  }
}
