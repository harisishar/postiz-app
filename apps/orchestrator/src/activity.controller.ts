import { Body, Controller, Param, Post, Res } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Response } from 'express';
import * as appModule from '@gitroom/orchestrator/app.module';

// Cloudflare deployment only (registered when WORKFLOWS_URL is set): the
// workflows run in the Worker and call the activities here. The port is not
// exposed by nginx, only the Worker can reach it.
@Controller('activity')
export class ActivityController {
  constructor(private _moduleRef: ModuleRef) {}

  @Post('/:name')
  async run(
    @Param('name') name: string,
    @Body() args: unknown[],
    @Res() res: Response
  ) {
    const instance = appModule.activities
      .map((activity) => this._moduleRef.get(activity, { strict: false }))
      .find(
        (activity: any) =>
          name !== 'constructor' && typeof activity?.[name] === 'function'
      );

    if (!instance) {
      return res.status(404).json({ error: `Unknown activity ${name}` });
    }

    try {
      return res.json({ result: await instance[name](...args) });
    } catch (err: any) {
      // same shape Temporal gives the workflow: an ApplicationFailure with the
      // error type (refresh_token, bad_body, ...) or the error class name
      return res.json({
        failure: {
          message: err?.message || '',
          type: err?.type || err?.name || 'Error',
          nonRetryable: !!err?.nonRetryable,
          details: err?.details,
        },
      });
    }
  }
}
