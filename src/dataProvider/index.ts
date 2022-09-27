import { fetchUtils, DataProvider, Identifier } from 'ra-core';

/**
 * Maps react-admin queries to a postgrest REST API
 *
 * This REST dialect uses postgrest syntax
 *
 * @see https://postgrest.org/en/stable/api.html#embedded-filters
 *
 * @example
 *
 * getList          => GET    http://my.api.url/posts?order=title.asc&offset=0&limit=24&filterField=eq.value
 * getOne           => GET    http://my.api.url/posts?id=eq.123
 * getMany          => GET    http://my.api.url/posts?id=in.(123,456,789)
 * getManyReference => GET    http://my.api.url/posts?author_id=eq.345
 * create           => POST   http://my.api.url/posts
 * update           => PATCH  http://my.api.url/posts?id=eq.123
 * updateMany       => PATCH  http://my.api.url/posts?id=in.(123,456,789)
 * delete           => DELETE http://my.api.url/posts?id=eq.123
 * deleteMany       => DELETE http://my.api.url/posts?id=in.(123,456,789)
 *
 * @example
 *
 * import * as React from 'react';
 * import { Admin, Resource } from 'react-admin';
 * import postgrestRestProvider from '@promitheus/ra-data-postgrest';
 *
 * import { PostList } from './posts';
 *
 * const App = () => (
 *     <Admin dataProvider={postgrestRestProvider('http://path.to.my.api/')}>
 *         <Resource name="posts" list={PostList} />
 *     </Admin>
 * );
 *
 * export default App;
 */

/*
  Attempting to combine logic from https://github.com/tomberek/aor-postgrest-client/blob/master/src/index.js#L29-L66
  The old postgrest data connector worked quite well, but wasn't keeping up with react-admin v4 changes
  Maybe in the future, defaultListOp should be an object that chooses a default op based on the datatype.
  That way, we can get some sensible defaults that users can extend without having to require using the @ splitter in all the columns
  A side effect of using the @ is that the i18nprovider/translate function will try to read a translation string that doesn't exist
*/
function parseFilters(filter, defaultListOp) {
  let result = {};
  Object.keys(filter).forEach(function (key) {
    // key: the name of the object key

    const splitKey = key.split('@');
    const hasSplitter = key.includes("@"); // used to check if rpc (split using @  but len < 2)
    const operation = splitKey.length == 2 ? splitKey[1] : defaultListOp;

    switch (typeof filter[key]) {
      case 'string':
        if (splitKey.length == 2) {
          // a string with non-default op
          result[key] = `${operation}.*` + filter[key].replace(/:/, '') + '*'
        } else {
          // rpc or default op
          result[key] = hasSplitter ? filter[key] : 'ilike.*' + filter[key].replace(/:/, '') + '*'
        }
        break

      case 'boolean':
        if (splitKey.length == 2) {
          // a boolean with non-default op
          result[key] = `${operation}.` + filter[key]
        } else {
          // rpc or default op
          result[key] = hasSplitter ? filter[key] : 'is.' + filter[key]
        }
        break

      case 'undefined':
        // probably don't need to use ${operation} to change this behavior
        result[key] = 'is.null'
        break

      case 'number':
        if (splitKey.length == 2) {
          // a number with non-default op
          result[key] = `${operation}.` + filter[key]
        } else {
          // rpc or default op
          result[key] = hasSplitter ? filter[key] : 'eq.' + filter[key]
        }
        break

      case 'object':
        // handle filter = {"numbers":[1,2,3]} the result should be either cs.{1,2,3} or in.{1,2,3}
        // the previous code returns eq.1,2,3 which won't result in any matches

        if (filter[key].constructor === Array) {
          if (splitKey.length == 2) {
            // an object with non-default op
            result[key] = `${operation}.{` + filter[key].toString().replace(/:/, '') + '}'
          } else {
            // rpc or default op
            result[key] = hasSplitter ? filter[key] :'cs.{' + filter[key].toString().replace(/:/, '') + '}'
          }
        } else {
          if (hasSplitter) {
            // TODO: what should the RPC syntax be? I'm assuming the spirit of the requirement is to just send them without filters
            result[key] = filter[key]
          } else {
            // inherited this logic from prior code from https://github.com/tomberek/aor-postgrest-client/blob/master/src/index.js#L54-L55
            Object.keys(filter[key]).map(val => (result[`${key}->>${val}`] = `ilike.*${filter[key][val]}*`))
          }
        }
        break

      default:
        result[key] = 'ilike.*' + filter[key].toString().replace(/:/, '') + '*'
        break
    }
  });

  return result;
}

// compound keys capability
type PrimaryKey = Array<string>;

const getPrimaryKey = (resource : string, primaryKeys: Map<string, PrimaryKey>) => {
  return primaryKeys.get(resource) || ['id'];
}

const decodeId = (id: Identifier, primaryKey: PrimaryKey): string[] => {
  if (isCompoundKey(primaryKey)) {
    return JSON.parse(id.toString());
  } else {
    return [id.toString()];
  }
}

const encodeId = (data: any, primaryKey: PrimaryKey): Identifier => {
  if (isCompoundKey(primaryKey)) {
    return JSON.stringify(primaryKey.map(key => data[key]));
  } else {
    return data[primaryKey[0]];
  }
}

const dataWithId = (data: any, primaryKey: PrimaryKey) => {
  // fix error TS2839: This condition will always return 'false' since JavaScript compares objects by reference, not value. if (primaryKey === ['id'])
  if (primaryKey ? primaryKey.length > 0 : false) {
    if (primaryKey[0] === 'id') {
      return data;
    }
  }

  return Object.assign(data, {
    id: encodeId(data, primaryKey)
  });
}

const isCompoundKey = (primaryKey: PrimaryKey) : Boolean => {
  return primaryKey.length > 1;
}

const getQuery = (primaryKey : PrimaryKey, ids: Identifier | Array<Identifier>, resource: string) : string => {
  if (Array.isArray(ids) && ids.length > 1) {
    // no standardized query with multiple ids possible for rpc endpoints which are api-exposed database functions
    if (resource.startsWith('rpc/')) {
      console.error('PostgREST\'s rpc endpoints are not intended to be handled as views. Therefore, no query generation for multiple key values implemented!');

      return ;
    }

    if (isCompoundKey(primaryKey)) {
      return `or=(
          ${ids.map(id => {
                const primaryKeyParams = decodeId(id, primaryKey);
                return `and(${primaryKey.map((key, i) => `${key}.eq.${primaryKeyParams[i]}`).join(',')})`;
              })
            }
        )`;
      } else {
        return new URLSearchParams({ [primaryKey[0]]: `in.(${ids.join(',')})` }).toString();
      }
  } else {
    // if ids is one Identifier
    const id : Identifier = ids.toString();
    const primaryKeyParams = decodeId(id, primaryKey);

    if (isCompoundKey(primaryKey)) {
      if (resource.startsWith('rpc/'))
        return `${primaryKey.map((key : string, i: any) => `${key}=${primaryKeyParams[i]}`).join('&')}`;
      else
        return `and=(${primaryKey.map((key : string, i: any) => `${key}.eq.${primaryKeyParams[i]}`).join(',')})`;
    } else {
      return new URLSearchParams([[primaryKey[0], `eq.${id}`]]).toString();
    }
  }
}

const getKeyData = (primaryKey : PrimaryKey, data: object) : object => {
  if (isCompoundKey(primaryKey)) {
    return primaryKey.reduce(
      (keyData, key) => ({
        ...keyData,
          [key]: data[key]
        }), 
      {});
  } else {
    return { [primaryKey[0]]: data[primaryKey[0]] };
  }
}

const getOrderBy = (field : string, order: string, primaryKey : PrimaryKey) => {
  if (field == 'id') {
    return primaryKey.map(key => (`${key}.${order.toLowerCase()}`)).join(',');
  } else {
    return `${field}.${order.toLowerCase()}`;
  }
};

const defaultPrimaryKeys = new Map<string, PrimaryKey>();

export default (apiUrl, httpClient = fetchUtils.fetchJson, defaultListOp = 'eq', 
                primaryKeys: Map<string, PrimaryKey> = defaultPrimaryKeys): DataProvider => ({
  getList: (resource, params) => {
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const { page, perPage } = params.pagination;
    const { field, order } = params.sort;
    const parsedFilter = parseFilters(params.filter, defaultListOp);

    const query = {
      order: getOrderBy(field, order, primaryKey),
      offset: String((page - 1) * perPage),
      limit: String(perPage),
      // append filters
      ...parsedFilter
    };

    // add header that Content-Range is in returned header
    const options = {
      headers: new Headers({
        Accept: 'application/json',
        Prefer: 'count=exact'
      })
    };

    const url = `${apiUrl}/${resource}?${new URLSearchParams(query)}`;

    return httpClient(url, options).then(({ headers, json }) => {
      if (!headers.has('content-range')) {
        throw new Error(
          `The Content-Range header is missing in the HTTP Response. The postgREST data provider expects 
          responses for lists of resources to contain this header with the total number of results to build 
          the pagination. If you are using CORS, did you declare Content-Range in the Access-Control-Expose-Headers header?`
        );
      }
      return {
        data: json.map(obj => dataWithId(obj, primaryKey)),
        total: parseInt(
          headers
            .get('content-range')
            .split('/')
            .pop(),
          10
        )
      };
    });
  },

  getOne: (resource, params) => {
    const id = params.id;
    const primaryKey = getPrimaryKey(resource, primaryKeys);
    
    const query = getQuery(primaryKey, id, resource);
    
    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url, {
      headers: new Headers({ 'accept': 'application/vnd.pgrst.object+json' }),
    }).then(({ json }) => ({
      data: dataWithId(json, primaryKey),
    }))
  },

  getMany: (resource, params) => {
    const ids = params.ids;
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const query = getQuery(primaryKey, ids, resource);
      
    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url).then(({ json }) => ({ data: json.map(data => dataWithId(data, primaryKey)) }));
  },

  getManyReference: (resource, params) => {
    const { page, perPage } = params.pagination;
    const { field, order } = params.sort;
    const parsedFilter = parseFilters(params.filter, defaultListOp);
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const query = params.target ? {
      [params.target]: `eq.${params.id}`,
      order: getOrderBy(field, order, primaryKey),
      offset: String((page - 1) * perPage),
      limit: String(perPage),
      ...parsedFilter,
    }:{
      order: getOrderBy(field, order, primaryKey),
      offset: String((page - 1) * perPage),
      limit: String(perPage),
      ...parsedFilter,
    };

    // add header that Content-Range is in returned header
    const options = {
      headers: new Headers({
        Accept: 'application/json',
        Prefer: 'count=exact'
      })
    }

    const url = `${apiUrl}/${resource}?${new URLSearchParams(query)}`;

    return httpClient(url, options).then(({ headers, json }) => {
      if (!headers.has('content-range')) {
        throw new Error(
          `The Content-Range header is missing in the HTTP Response. The postgREST data provider expects 
          responses for lists of resources to contain this header with the total number of results to build 
          the pagination. If you are using CORS, did you declare Content-Range in the Access-Control-Expose-Headers header?`
        );
      }
      return {
        data: json.map(data => dataWithId(data, primaryKey)),
        total: parseInt(
          headers
            .get('content-range')
            .split('/')
            .pop(),
          10
        ),
      };
    });
  },

  update: (resource, params) => {
    const { id, data } = params;
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const query = getQuery(primaryKey, id, resource);

    const primaryKeyData = getKeyData(primaryKey, data);

    const url = `${apiUrl}/${resource}?${query}`;

    const body = JSON.stringify({
      ...data,
      ...primaryKeyData
    });

    return httpClient(url, {
      method: 'PATCH',
      headers: new Headers({
        'Accept': 'application/vnd.pgrst.object+json',
        'Prefer': 'return=representation',
        'Content-Type': 'application/json'
      }),
      body,
    }).then(({ json }) => ({ data: dataWithId(json, primaryKey) }));
  },

  updateMany: (resource, params) => {
    const ids = params.ids;
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const query = getQuery(primaryKey, ids, resource);

    const body = JSON.stringify(
      params.data.map(obj => {
        const { id, ...data } = obj;
        const primaryKeyData = getKeyData(primaryKey, data);

        return {
          ...data,
          ...primaryKeyData
        };
      })
    );

    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url, {
      method: 'PATCH',
      headers: new Headers({
        'Prefer': 'return=representation',
        'Content-Type': 'application/json',
      }),
      body,
    }).then(({ json }) => ({
      data: json.map(data => encodeId(data, primaryKey))
    }));
  },

  create: (resource, params) => {
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const url = `${apiUrl}/${resource}`;

    return httpClient(url, {
      method: 'POST',
      headers: new Headers({
        'Accept': 'application/vnd.pgrst.object+json',
        'Prefer': 'return=representation',
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify(params.data),
    }).then(({ json }) => ({
      data: {
        ...params.data,
        id: encodeId(json, primaryKey)
      }
    }));
  },

  delete: (resource, params) => {
    const id = params.id;
    const primaryKey = getPrimaryKey(resource, primaryKeys);
    
    const query = getQuery(primaryKey, id, resource);

    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url, {
      method: 'DELETE',
      headers: new Headers({
        'Accept': 'application/vnd.pgrst.object+json',
        'Prefer': 'return=representation',
        'Content-Type': 'application/json'
      }),
    }).then(({ json }) => ({ data: dataWithId(json, primaryKey) }));
  },

  deleteMany: (resource, params) => {
    const ids = params.ids;
    const primaryKey = getPrimaryKey(resource, primaryKeys);

    const query = getQuery(primaryKey, ids, resource);
      
    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url, {
      method: 'DELETE',
      headers: new Headers({
        'Prefer': 'return=representation',
        'Content-Type': 'application/json'
      }),
    }).then(({ json }) => ({ data: json.map(data => encodeId(data, primaryKey)) }));
  },
});
