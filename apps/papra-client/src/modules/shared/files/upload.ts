export async function promptUploadFiles({
  acceptedTypes,
  directory,
}: {
  acceptedTypes?: string;
  directory?: boolean;
} = {}): Promise<{ files: File[] }> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (directory) input.setAttribute('webkitdirectory', '');

    if (acceptedTypes) {
      input.accept = acceptedTypes;
    }

    input.onchange = () => {
      resolve({ files: [...(input.files ?? [])] });
    };
    input.oncancel = () => resolve({files:[]});

    input.click();
  });
}
