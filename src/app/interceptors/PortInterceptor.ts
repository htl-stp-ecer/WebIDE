import { Injectable } from '@angular/core';
import {
  HttpInterceptor,
  HttpRequest,
  HttpHandler,
  HttpEvent
} from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable()
export class PortInterceptor implements HttpInterceptor {
  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    let url = req.url;

    if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
      return next.handle(req);
    }

    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    try {
      const parsed = new URL(url);

      if (!parsed.port) {
        parsed.port = '8421';
      }

      const newUrl = `${parsed.protocol}//${parsed.hostname}:${parsed.port}${parsed.pathname}${parsed.search}${parsed.hash}`;

      let headers = req.headers;
      const token = localStorage.getItem('raccoon_device_token');
      if (token) {
        headers = headers.set('X-API-Token', token);
      }

      const clonedReq = req.clone({ url: newUrl, headers });
      return next.handle(clonedReq);
    } catch (e) {
      console.error('PortInterceptor failed', e);
      return next.handle(req);
    }
  }
}
