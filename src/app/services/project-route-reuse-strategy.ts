import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, BaseRouteReuseStrategy } from '@angular/router';

@Injectable()
export class ProjectRouteReuseStrategy extends BaseRouteReuseStrategy {
  override shouldReuseRoute(future: ActivatedRouteSnapshot, current: ActivatedRouteSnapshot): boolean {
    return super.shouldReuseRoute(future, current) &&
      (!future.routeConfig?.data?.['recreateOnProjectChange'] ||
        future.paramMap.get('uuid') === current.paramMap.get('uuid'));
  }
}
