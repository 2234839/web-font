import { createParamDecorator } from '@nestjs/common';
import { Request } from 'express';

export const req_par = createParamDecorator((data: string, req:Request) => {
    if('host_url'===data){
        return `//${req.headers.host}/`
    }
    return req
});
