import { mergeSchemas } from '@graphql-tools/schema';
import { printSchemaWithDirectives } from '@graphql-tools/utils';
import { Injectable } from '@nestjs/common';
import { loadPackage } from '@nestjs/common/utils/load-package.util';
import { isString } from '@nestjs/common/utils/shared.utils';
import {
  GraphQLAbstractType,
  GraphQLField,
  GraphQLInputField,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLResolveInfo,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLUnionType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  specifiedDirectives,
} from 'graphql';
import { gql } from 'graphql-tag';
import { forEach, isEmpty } from 'lodash';
import { GraphQLSchemaBuilder } from '../graphql-schema.builder';
import { GraphQLSchemaHost } from '../graphql-schema.host';
import {
  AutoSchemaFileValue,
  BuildFederatedSchemaOptions,
  FederationConfig,
  FederationVersion,
  GqlModuleOptions,
} from '../interfaces';
import { ResolversExplorerService, ScalarsExplorerService } from '../services';
import { extend } from '../utils';
import { transformSchema } from '../utils/transform-schema.util';
import { TypeDefsDecoratorFactory } from './type-defs-decorator.factory';

const DEFAULT_FEDERATION_VERSION: FederationVersion = 1;

@Injectable()
export class GraphQLFederationFactory {
  constructor(
    private readonly resolversExplorerService: ResolversExplorerService,
    private readonly scalarsExplorerService: ScalarsExplorerService,
    private readonly gqlSchemaBuilder: GraphQLSchemaBuilder,
    private readonly gqlSchemaHost: GraphQLSchemaHost,
    private readonly typeDefsDecoratorFactory: TypeDefsDecoratorFactory,
  ) {}

  async mergeWithSchema<T extends GqlModuleOptions>(
    options: T = {} as T,
    buildFederatedSchema?: (
      options: BuildFederatedSchemaOptions,
    ) => GraphQLSchema,
  ): Promise<T> {
    const transformSchema = async (schema: GraphQLSchema) =>
      options.transformSchema ? options.transformSchema(schema) : schema;

    let schema: GraphQLSchema;
    if (options.autoSchemaFile) {
      schema = await this.generateSchema(options, buildFederatedSchema);
    } else if (isEmpty(options.typeDefs)) {
      schema = options.schema;
    } else {
      schema = this.buildSchemaFromTypeDefs(options);
    }

    this.gqlSchemaHost.schema = schema;

    return {
      ...options,
      schema: await transformSchema(schema),
      typeDefs: undefined,
    };
  }

  private buildSchemaFromTypeDefs<T extends GqlModuleOptions>(options: T) {
    const { buildSubgraphSchema }: typeof import('@apollo/subgraph') =
      loadPackage('@apollo/subgraph', 'ApolloFederation', () =>
        require('@apollo/subgraph'),
      );

    return buildSubgraphSchema([
      {
        typeDefs: gql`
          ${options.typeDefs}
        `,
        resolvers: this.getResolvers(options.resolvers),
      },
    ]);
  }

  private async generateSchema<T extends GqlModuleOptions>(
    options: T,
    buildFederatedSchema?: (
      options: BuildFederatedSchemaOptions,
    ) => GraphQLSchema,
  ): Promise<GraphQLSchema> {
    const apolloSubgraph = loadPackage(
      '@apollo/subgraph',
      'ApolloFederation',
      () => require('@apollo/subgraph'),
    );
    const apolloSubgraphVersion = (
      await import('@apollo/subgraph/package.json')
    ).version;

    const apolloSubgraphMajorVersion = Number(
      apolloSubgraphVersion.split('.')[0],
    );
    const printSubgraphSchema = apolloSubgraph.printSubgraphSchema;

    if (!buildFederatedSchema) {
      buildFederatedSchema = apolloSubgraph.buildSubgraphSchema;
    }

    const autoGeneratedSchema: GraphQLSchema = await this.buildFederatedSchema(
      options.autoSchemaFile,
      options,
      this.resolversExplorerService.getAllCtors(),
    );
    let typeDefs =
      apolloSubgraphMajorVersion >= 2
        ? printSchemaWithDirectives(autoGeneratedSchema)
        : printSubgraphSchema(autoGeneratedSchema);

    const [federationVersion, federationOptions] =
      this.getFederationVersionAndConfig(options.autoSchemaFile);

    const typeDefsDecorator = this.typeDefsDecoratorFactory.create(
      federationVersion,
      apolloSubgraphMajorVersion,
    );
    if (typeDefsDecorator) {
      typeDefs = typeDefsDecorator.decorate(typeDefs, federationOptions);
    }

    let executableSchema: GraphQLSchema = buildFederatedSchema({
      typeDefs: gql(typeDefs),
      resolvers: this.getResolvers(options.resolvers),
    });

    executableSchema = this.overrideOrExtendResolvers(
      executableSchema,
      autoGeneratedSchema,
      printSubgraphSchema,
    );

    const schema = options.schema
      ? mergeSchemas({
          schemas: [options.schema, executableSchema],
        })
      : executableSchema;
    return schema;
  }

  private getResolvers(optionResolvers: any) {
    optionResolvers = Array.isArray(optionResolvers)
      ? optionResolvers
      : [optionResolvers];
    return this.extendResolvers([
      this.resolversExplorerService.explore(),
      ...this.scalarsExplorerService.explore(),
      ...optionResolvers,
    ]);
  }

  private extendResolvers(resolvers: any[]) {
    return resolvers.reduce((prev, curr) => extend(prev, curr), {});
  }

  private overrideOrExtendResolvers(
    executableSchema: GraphQLSchema,
    autoGeneratedSchema: GraphQLSchema,
    printSchema: (schema: GraphQLSchema) => string,
  ): GraphQLSchema {
    return transformSchema(executableSchema, (type) => {
      if (isUnionType(type) && type.name !== '_Entity') {
        return this.overrideFederatedResolveType(type, autoGeneratedSchema);
      } else if (isInterfaceType(type)) {
        return this.overrideFederatedResolveType(type, autoGeneratedSchema);
      } else if (isEnumType(type)) {
        return autoGeneratedSchema.getType(type.name);
      } else if (isInputObjectType(type)) {
        const autoGeneratedInputType = autoGeneratedSchema.getType(
          type.name,
        ) as GraphQLInputObjectType;

        if (!autoGeneratedInputType) {
          return type;
        }
        const fields = type.getFields();
        forEach(fields, (value: GraphQLInputField, key: string) => {
          const field = autoGeneratedInputType.getFields()[key];
          if (!field) {
            return;
          }
          value.extensions = field.extensions;
          value.astNode = field.astNode;
        });
        type.extensions = autoGeneratedInputType.extensions;
        return type;
      } else if (isObjectType(type)) {
        const autoGeneratedObjectType = autoGeneratedSchema.getType(
          type.name,
        ) as GraphQLObjectType;

        if (!autoGeneratedObjectType) {
          return type;
        }
        const fields = type.getFields();
        forEach(
          fields,
          (value: GraphQLField<unknown, unknown>, key: string) => {
            const field = autoGeneratedObjectType.getFields()[key];
            if (!field) {
              return;
            }
            value.extensions = field.extensions;
            value.astNode = field.astNode;

            if (!value.resolve) {
              value.resolve = field.resolve;
            }
          },
        );
        if (autoGeneratedObjectType.astNode) {
          type.astNode = {
            ...type.astNode,
            ...autoGeneratedObjectType.astNode,
          };
        }
        type.extensions = {
          ...type.extensions,
          ...autoGeneratedObjectType.extensions,
        };
        return type;
      } else if (isScalarType(type) && type.name === 'DateTime') {
        const autoGeneratedScalar = autoGeneratedSchema.getType(
          type.name,
        ) as GraphQLScalarType;

        if (!autoGeneratedScalar) {
          return type;
        }
        type.parseLiteral = autoGeneratedScalar.parseLiteral;
        type.parseValue = autoGeneratedScalar.parseValue;
        return type;
      }
      return type;
    });
  }

  /**
   * Ensures that the resolveType method for unions and interfaces in the federated schema
   * is properly set from the one in the autoGeneratedSchema.
   */
  private overrideFederatedResolveType(
    typeInFederatedSchema: GraphQLUnionType | GraphQLInterfaceType,
    autoGeneratedSchema: GraphQLSchema,
  ): GraphQLUnionType | GraphQLInterfaceType {
    // Get the matching type from the auto generated schema
    const autoGeneratedType = autoGeneratedSchema.getType(
      typeInFederatedSchema.name,
    );
    // Bail if inconsistent with original schema
    if (
      !autoGeneratedType ||
      !(
        autoGeneratedType instanceof GraphQLUnionType ||
        autoGeneratedType instanceof GraphQLInterfaceType
      ) ||
      !autoGeneratedType.resolveType
    ) {
      return typeInFederatedSchema;
    }

    typeInFederatedSchema.resolveType = async (
      value: unknown,
      context: unknown,
      info: GraphQLResolveInfo,
      abstractType: GraphQLAbstractType,
    ) => {
      const resultFromAutogenSchema: any = await autoGeneratedType.resolveType(
        value,
        context,
        info,
        abstractType,
      );
      // If the result is not a GraphQLObjectType we're fine
      if (!resultFromAutogenSchema || isString(resultFromAutogenSchema)) {
        return resultFromAutogenSchema;
      }
      // We now have a GraphQLObjectType from the original union in the autogenerated schema.
      // But we can't return that without the additional federation property apollo adds to object
      // types (see node_modules/@apollo/federation/src/composition/types.ts:47).
      // Without that property, Apollo will ignore the returned type and the
      // union value will resolve to null. So we need to return the type with
      // the same name from the federated schema
      const resultFromFederatedSchema = info.schema.getType(
        resultFromAutogenSchema.name,
      );
      if (
        resultFromFederatedSchema &&
        resultFromFederatedSchema instanceof GraphQLObjectType
      ) {
        return resultFromFederatedSchema;
      }
      // If we couldn't find a match in the federated schema, return just the
      // name of the type and hope apollo works it out
      return resultFromAutogenSchema;
    };
    return typeInFederatedSchema;
  }

  async buildFederatedSchema<T extends GqlModuleOptions>(
    autoSchemaFile: AutoSchemaFileValue,
    options: T,
    resolvers: Function[],
  ) {
    const scalarsMap = this.scalarsExplorerService.getScalarsMap();
    try {
      const buildSchemaOptions = options.buildSchemaOptions || {};
      const directives = [...specifiedDirectives];
      const [federationVersion] =
        this.getFederationVersionAndConfig(autoSchemaFile);

      if (federationVersion < 2) {
        directives.push(...this.loadFederationDirectives());
      }
      if (buildSchemaOptions?.directives) {
        directives.push(...buildSchemaOptions.directives);
      }

      return await this.gqlSchemaBuilder.generateSchema(
        resolvers,
        autoSchemaFile,
        {
          ...buildSchemaOptions,
          directives,
          scalarsMap,
          skipCheck: true,
        },
        options.sortSchema,
        options.transformAutoSchemaFile && options.transformSchema,
      );
    } catch (err) {
      if (err && err.details) {
        console.error(err.details);
      }
      throw err;
    }
  }

  private getFederationVersionAndConfig(
    autoSchemaFile: AutoSchemaFileValue,
  ): [FederationVersion, FederationConfig?] {
    if (!autoSchemaFile || typeof autoSchemaFile !== 'object') {
      return [DEFAULT_FEDERATION_VERSION];
    }
    if (typeof autoSchemaFile.federation !== 'object') {
      return [autoSchemaFile.federation ?? DEFAULT_FEDERATION_VERSION];
    }
    return [
      autoSchemaFile.federation?.version ?? DEFAULT_FEDERATION_VERSION,
      autoSchemaFile.federation,
    ];
  }

  private loadFederationDirectives() {
    const { federationDirectives, directivesWithNoDefinitionNeeded } =
      loadPackage('@apollo/subgraph/dist/directives', 'SchemaBuilder', () =>
        require('@apollo/subgraph/dist/directives'),
      );
    return federationDirectives ?? directivesWithNoDefinitionNeeded;
  }
}
