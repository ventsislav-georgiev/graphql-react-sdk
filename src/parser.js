import _ from 'lodash';
import pluralize from 'pluralize';
import {gql} from '@apollo/client';

function generateFields({
  fields,
  otherTypes,
  selectedFields,
  skipNested = false,
}) {
  const hasSelectedFields = _.isObjectLike(selectedFields);
  return fields
    .map(f => {
      const fieldName = f.name.value;
      const fieldTypeName =
        (f.type.name && f.type.name.value) ||
        (f.type.type && f.type.type.name.value) ||
        '';

      if (
        fieldTypeName !== 'ID' &&
        hasSelectedFields &&
        !selectedFields[fieldName]
      ) {
        return '';
      }

      let field = fieldName;

      if (!skipNested && otherTypes[fieldTypeName]) {
        const childFields = otherTypes[fieldTypeName].fields;
        const childSelectedFields = hasSelectedFields
          ? selectedFields[fieldName]
          : null;
        field += `{
${generateFields({
  fields: childFields,
  otherTypes,
  selectedFields: childSelectedFields,
})}
}`;
      }

      return field;
    })
    .join('\n');
}

function generateInputFields({fields, selectedFields}) {
  const hasSelectedFields = _.isObjectLike(selectedFields);
  let variables = [];
  let inputFields = [];
  fields.forEach(f => {
    const fieldName = f.name.value;
    if (hasSelectedFields && !selectedFields[fieldName]) {
      return '';
    }
    variables.push('$' + f.name.value + ': ' + f.type.name.value);
    inputFields.push(f.name.value + ': $' + f.name.value);
  });
  return {variables: variables.join(','), fields: inputFields.join(',')};
}

export function parseType(typeGQL) {
  if (!typeGQL || !typeGQL.definitions) {
    throw new Error('GraphQL type is required');
  }

  if (
    typeGQL.definitions[0].kind !== 'ObjectTypeDefinition' ||
    typeGQL.definitions[1].kind !== 'InputObjectTypeDefinition' ||
    !_.startsWith(
      typeGQL.definitions[1].name.value,
      typeGQL.definitions[0].name.value,
    )
  ) {
    throw new Error(
      'GraphQL type schema should start with the desired type and its input before other types',
    );
  }

  const dataType = typeGQL.definitions[0];
  const inputType = typeGQL.definitions[1];

  const otherTypes = {};
  typeGQL.definitions.slice(2).forEach(d => {
    otherTypes[d.name.value] = d;
  });

  const typeName = dataType.name.value;
  const typeNameCamelCase = _.lowerFirst(typeName);
  const typeNamePlural = pluralize.plural(typeName);
  const typeNamePluralCamelCase = _.lowerFirst(typeNamePlural);

  const idFieldName = _.find(
    dataType.fields,
    f =>
      (f.type.name && f.type.name.value) ||
      (f.type.type && f.type.type.name.value) === 'ID',
  ).name.value;

  const hasEditResponse = !!_.find(
    dataType.directives,
    d => d.name.value === 'withEditResponse',
  );

  const itemType = {
    typeName,
    typeNameCamelCase,
    typeNamePlural,
    typeNamePluralCamelCase,

    dataType,
    inputType,
    otherTypes,
    fields: dataType.fields,
    inputFields: inputType.fields,
    idFieldName,
    hasEditResponse,
  };

  itemType.list = (options = {}) => {
    const value = gql`
query ${typeNamePlural} {
results: ${typeNamePluralCamelCase} {
${generateFields({
  fields: dataType.fields,
  otherTypes,
  selectedFields: options.selectedFields,
})}
}
}`;
    value.__options__ = options;
    value.__querytype__ = 'list';
    value.__itemtype__ = itemType;
    return value;
  };

  itemType.get = (options = {}) => {
    const value = gql`
query ${typeName}($id: ID!) {
result: ${typeNameCamelCase}(id: $id) {
${generateFields({
  fields: dataType.fields,
  otherTypes,
  selectedFields: options.selectedFields,
})}
}
}`;
    value.__options__ = options;
    value.__querytype__ = 'get';
    value.__itemtype__ = itemType;
    return value;
  };

  itemType.add = (options = {}) => {
    const {variables, fields} = generateInputFields({
      fields: inputType.fields,
      otherTypes,
      selectedFields: options.selectedFields,
    });
    const addResponse = `{
${generateFields({
  fields: dataType.fields,
  skipNested: true,
})}
}`;

    const value = gql`
mutation Add${typeName}(${variables}) {
result: add${typeName}(data: {${fields}}) ${addResponse}
}`;
    value.__options__ = options;
    value.__querytype__ = 'add';
    value.__itemtype__ = itemType;
    return value;
  };

  itemType.edit = (options = {}) => {
    const {variables, fields} = generateInputFields({
      fields: inputType.fields,
      otherTypes,
      selectedFields: options.selectedFields,
    });
    let editResponse = '';
    if (hasEditResponse) {
      editResponse = `{
${generateFields({
  fields: dataType.fields,
  skipNested: true,
})}
}`;
    }

    const value = gql`
mutation Update${typeName}($id: ID!, ${variables}) {
  result: update${typeName}(id: $id, data: {${fields}}) ${editResponse}
}`;
    value.__options__ = options;
    value.__querytype__ = 'edit';
    value.__itemtype__ = itemType;
    return value;
  };

  itemType.remove = (options = {}) => {
    const value = gql`
mutation Remove${typeName}($id: ID!) {
  result: remove${typeName}(id: $id)
}`;
    value.__options__ = options;
    value.__querytype__ = 'remove';
    value.__itemtype__ = itemType;
    return value;
  };

  return itemType;
}
